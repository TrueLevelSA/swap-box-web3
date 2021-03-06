// Swap-box
// Copyright (C) 2019  TrueLevel SA
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import BN from "bn.js";
import { Address } from "web3x/address";
import { socket } from "zeromq";

import { Atola } from "./contracts/Atola";
import { PriceFeed } from "./contracts/PriceFeed";

import { Contracts } from "./contracts";
import { INodeStatus, Node } from "./node";
import { processBuyEthOrder } from "./processing/orders";

import * as config from "../config.json";

interface IReply {
  status: "success" | "error";
  result: string;
}

interface IMessage {
  method: "buy";
  amount: string;
  min_eth: string;
  address: string;
}

export interface IReserves {
  token_reserve: BN;
  eth_reserve: BN;
}

export class Zmq {
  private readonly pubPrice = socket("pub");
  private readonly pubStatus = socket("pub");
  private readonly rep = socket("rep");

  private readonly atola: Atola;
  private readonly priceFeed: PriceFeed;
  private readonly machineAddress: Address;

  private readonly TOPIC_PRICETICKER = "priceticker";
  private readonly TOPIC_STATUS = "status";

  constructor(private node: Node) {
    // initialize publisher/responder
    this.pubPrice.bindSync(config.zmq.url_pub_price);
    this.pubStatus.bindSync(config.zmq.url_pub_status);
    this.rep.bindSync(config.zmq.url_replier);

    // init contracts
    const contracts = new Contracts(this.node.eth());
    this.atola = contracts.atola();
    this.priceFeed = contracts.priceFeed();

    this.machineAddress = node.accounts()[0];

    // init zmq listener for incoming orders
    this.initializeListener();
  }

  public sendStatus = (nodeStatus: INodeStatus) => {
    const msg = [this.TOPIC_STATUS, JSON.stringify(nodeStatus)];
    console.log(`ZMQ: ${msg}`);
    this.pubStatus.send(msg);
  }

  /**
   * Fetch new price and send them through zmq.
   */
  public updatePriceticker = async () => {
    const reserves = await this.fetchReserves();
    const msg = [this.TOPIC_PRICETICKER, JSON.stringify(reserves)];
    console.log(`ZMQ: ${msg}`);
    this.pubPrice.send(msg);
    return reserves;
  }

  /**
   * Fetch exchange reserves using priceFeed contract.
   *
   * @returns reserves A promise of an IReserves interface
   */
  private fetchReserves = async (): Promise<IReserves> => {
    const raw = await this.priceFeed.methods.getReserves().call();
    return {
      token_reserve: new BN(raw[0]),
      eth_reserve: new BN(raw[1]),
    };
  }

  /**
   * Intialize zmq req/rep.
   */
  private initializeListener = () => {
    this.rep.on("message", async (request) => {
      // exit if node is not connected or not in sync.
      // it might happen if order is sent after the node went down and the status
      // hasnt been updated yet.
      const status = await this.node.getStatus();
      if (!status.is_connected || status.is_syncing) {
        console.error("Node is not connected or not in sync");
        return;
      }

      const reply: IReply = {status: "error", result: "undefined"};
      const message: IMessage = JSON.parse(request.toString());
      console.log("zmq.onMessage:", message);

      if (message.method === "buy") {
        // send buy oder
        try {
          const ethBought = await processBuyEthOrder(
            this.atola,
            this.machineAddress,
            new BN(message.amount),
            new BN(message.min_eth),
            Address.fromString(message.address),
          );
          if (ethBought) {
            reply.status = "success";
            reply.result = ethBought.cryptoAmount;
            console.log(reply);
          }
        } catch (error) {
          reply.result = "error while processBuyEthOrder";
          console.error(error);
        }
      } else if (message.method === "sell") {
        // send sell order
        // Need to make a function for startSell (listen for ethrecieved event)
        // Call this function when we get the EthRecieved event
        // const success = await processSellETHOrder(eth, OperatorContract, message.amount, message.address);
        reply.result = "Sell not supported yet";
      } else {
        reply.result = "Invalid method";
      }

      // reply
      this.rep.send(JSON.stringify(reply));
    });
  }
}

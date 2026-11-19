import { main } from "@withmarfa/connector";
import { connector } from "./definition.js";

await main(connector(process.env));

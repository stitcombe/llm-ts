#!/usr/bin/env node
import { cli } from "./cli.js";
import { main } from "./click/index.js";

void main(cli, process.argv.slice(2));

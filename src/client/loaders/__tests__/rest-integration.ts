import { createRestLoader } from "../rest";
import { loaderContract } from "./contract";

loaderContract("REST", createRestLoader, (value) => value);

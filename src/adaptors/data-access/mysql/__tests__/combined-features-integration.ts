import { combined } from "~/__tests__/storage/combined";

import { setupSequelize } from "../../sequelize/__tests__/fixture";
import { setupMysql } from "./fixture";

combined("mysql", setupMysql);
combined("Sequelize mysql", () => setupSequelize("mysql"));

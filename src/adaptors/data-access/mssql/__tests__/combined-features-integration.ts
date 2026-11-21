import { combined } from "~/__tests__/storage/combined";

import { setupSequelize } from "../../sequelize/__tests__/fixture";
import { setupMssql } from "./fixture";

combined("mssql", setupMssql);
combined("Sequelize mssql", () => setupSequelize("mssql"));

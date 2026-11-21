import { combined } from "~/__tests__/storage/combined";

import { setupSequelize } from "../../sequelize/__tests__/fixture";
import { setupPostgres } from "./fixture";

combined("postgres", setupPostgres);
combined("Sequelize postgres", () => setupSequelize("postgres"));

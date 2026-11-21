import { combined } from "~/__tests__/storage/combined";

import { dynamodbFixture } from "./fixture";

combined("dynamodb", dynamodbFixture);

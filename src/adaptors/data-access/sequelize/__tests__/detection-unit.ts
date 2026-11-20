import { Sequelize } from "sequelize";
import { expect, it, vi } from "vitest";

import { detectClient } from "~/server/detectClient";

it.each(["postgres", "mysql", "mssql"] as const)(
  "detects Sequelize %s without opening the connection",
  async (dialect) => {
    const client = new Sequelize({ dialect, logging: false });
    const query = vi.spyOn(client, "query");
    try {
      expect(detectClient(client, {})).toMatchObject({ driverKind: "sequelize", dialect });
      expect(query).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  },
);

it("rejects unsupported Sequelize dialects at construction", async () => {
  const client = new Sequelize({ dialect: "sqlite", dialectModule: {}, logging: false });
  try {
    expect(() => detectClient(client, {})).toThrow(/Unsupported Sequelize dialect "sqlite"/);
  } finally {
    await client.close();
  }
});

import type { ConnectionPool } from "mssql";

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PKey } from "~/entities";

import { experimentInput } from "~/__tests__/storage/contract";

const mocks = vi.hoisted(() => ({ loadDriver: vi.fn() }));
vi.mock("~/adaptors/data-access/optionalDriver", () => mocks);

import MssqlAdaptor from "..";

describe("SQL Server sessions", () => {
  const execute = vi.fn();
  const rollback = vi.fn();
  const commit = vi.fn();
  const begin = vi.fn();
  const calls: {
    statement: string;
    values: Record<string, { type: unknown; value: unknown }>;
    owner: unknown;
  }[] = [];
  const transactions: EventEmitter[] = [];
  const intType = Symbol("Int");
  const floatType = Symbol("Float");
  const bitType = Symbol("Bit");
  const stringType = Symbol("NVarChar(MAX)");

  function request(owner: unknown) {
    const values: Record<string, { type: unknown; value: unknown }> = {};
    return {
      input(name: string, type: unknown, value: unknown) {
        values[name] = { type, value };
        return this;
      },
      async query(statement: string) {
        calls.push({ statement, values, owner });
        return execute(statement);
      },
    };
  }

  class FakeTransaction extends EventEmitter {
    begin = begin;
    commit = commit;
    rollback = rollback;
    constructor(public pool: unknown) {
      super();
      transactions.push(this);
    }
    request() {
      return request(this);
    }
  }

  const pool = {
    request() {
      return request(pool);
    },
    close: vi.fn(),
    connect: vi.fn(),
  };
  const adaptor = () => new MssqlAdaptor(pool as unknown as ConnectionPool);

  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockReset().mockResolvedValue({ recordset: [] });
    rollback.mockReset().mockResolvedValue(undefined);
    commit.mockReset().mockResolvedValue(undefined);
    begin.mockReset().mockResolvedValue(undefined);
    calls.length = 0;
    transactions.length = 0;
    mocks.loadDriver.mockReturnValue({
      Transaction: FakeTransaction,
      Int: intType,
      Float: floatType,
      Bit: bitType,
      MAX: -1,
      NVarChar: () => stringType,
    });
  });

  it("uses transaction-bound typed requests and OUTPUT INSERTED without owning the pool", async () => {
    const input = experimentInput();
    input.cohorts[0]!.percentage = 12.5;
    execute.mockImplementation(async (statement: string) => {
      if (statement.startsWith("INSERT INTO experiments")) {
        return {
          recordset: [
            {
              id: 1,
              name: input.name,
              slug: input.slug,
              type: input.type,
              description: input.description,
              winner: null,
            },
          ],
        };
      }
      if (statement.startsWith("INSERT INTO cohorts")) return { recordset: [{ id: 2 }] };
      return { recordset: [] };
    });
    await adaptor().experimentDAO.create(input);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.owner === transactions[0])).toBe(true);
    expect(calls[0]!.statement).toContain("OUTPUT INSERTED.* VALUES (@p1");
    expect(calls[0]!.values["p1"]).toEqual({ type: stringType, value: input.name });
    expect(calls[0]!.values["p5"]).toEqual({ type: stringType, value: null });
    expect(calls[1]!.values["p1"]).toEqual({ type: intType, value: 1 });
    expect(calls[1]!.values["p5"]).toEqual({ type: floatType, value: 12.5 });
    expect(begin).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.close).not.toHaveBeenCalled();
  });

  it("rolls back the transaction and preserves the original query failure", async () => {
    const failure = new Error("injected query failure");
    execute.mockRejectedValue(failure);
    await expect(adaptor().experimentDAO.create(experimentInput())).rejects.toBe(failure);
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(pool.close).not.toHaveBeenCalled();
  });

  it("preserves both errors if rollback itself fails", async () => {
    const failure = new Error("query failed");
    const rollbackFailure = new Error("rollback failed");
    execute.mockRejectedValue(failure);
    rollback.mockRejectedValue(rollbackFailure);
    await expect(adaptor().experimentDAO.create(experimentInput())).rejects.toMatchObject({
      errors: [failure, rollbackFailure],
      cause: rollbackFailure,
    });
  });

  it("does not issue another rollback after a server-initiated abort", async () => {
    const failure = new Error("transaction aborted");
    execute.mockImplementation(async () => {
      transactions[0]!.emit("rollback", true);
      throw failure;
    });
    await expect(adaptor().experimentDAO.create(experimentInput())).rejects.toBe(failure);
    expect(rollback).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("locks parent records before mutation and leaves reads outside transactions", async () => {
    const storage = adaptor();
    await storage.experimentDAO.remove(1 as PKey<"Experiment">);
    expect(calls[0]!.statement).toBe(
      "SELECT * FROM experiments WITH (UPDLOCK, HOLDLOCK) WHERE id = @p1",
    );
    expect(calls[0]!.owner).toBe(transactions[0]);
    expect(commit).toHaveBeenCalledOnce();
    await storage.experimentDAO.list();
    expect(calls.at(-1)!.owner).toBe(pool);
    expect(transactions).toHaveLength(1);
  });
});

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { describe, expect, it, vi } from "vitest";

import type { CreationPayload, Experiment, PKey } from "~/entities";

import { experimentInput } from "~/__tests__/storage/contract";

import DynamoDBAdaptor from "..";
import { encodeUserId } from "../schema";

const experimentId = "experiment-id" as PKey<"Experiment">;
const root = {
  ...experimentInput(),
  id: experimentId,
  winner: null,
  state: "active",
  pk: "EXP#experiment-id",
  sk: "META",
};

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe("DynamoDB request boundaries", () => {
  it("rejects 33 initial cohorts before contacting DynamoDB", async () => {
    const send = vi.fn();
    const input = experimentInput();
    input.cohorts = Array.from({ length: 33 }, (_, index) => ({
      ...input.cohorts[0]!,
      slug: `checkout-test_cohort-${index}`,
    })) as CreationPayload<Experiment>["cohorts"];
    await expect(
      new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO.create(input),
    ).rejects.toThrow("32 initial cohorts");
    expect(send).not.toHaveBeenCalled();
  });

  it("drains all cohort query pages and keeps internal attributes private", async () => {
    const first = {
      ...root.cohorts[0],
      id: "first",
      experiment_id: experimentId,
      state: "active",
      pk: root.pk,
      sk: "C#first",
    };
    const second = {
      ...root.cohorts[1],
      id: "second",
      experiment_id: experimentId,
      state: "active",
      pk: root.pk,
      sk: "C#second",
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: root })
      .mockResolvedValueOnce({ Items: [first], LastEvaluatedKey: { pk: root.pk, sk: first.sk } })
      .mockResolvedValueOnce({ Items: [second] })
      .mockResolvedValueOnce({ Item: root });
    const cohorts = await new DynamoDBAdaptor(fakeClient(send), "xp").cohortDAO.getByExperimentId(
      experimentId,
    );
    expect(cohorts.map((cohort) => cohort.id)).toEqual(["first", "second"]);
    expect(cohorts[0]).not.toHaveProperty("state");
    expect(cohorts[0]).not.toHaveProperty("pk");
    expect(send.mock.calls[2]![0].input.ExclusiveStartKey).toEqual({ pk: root.pk, sk: first.sk });
  });

  it("repeats the cohort read if the allocation changed during its query", async () => {
    const previous = { ...root, rollout_revision: 1, rollout_phase: "allocating" };
    const committed = { ...previous, rollout_revision: 2 };
    const cohort = { ...root.cohorts[0], id: "off", experiment_id: experimentId, state: "active" };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: previous })
      .mockResolvedValueOnce({ Items: [{ ...cohort, percentage: 90 }] })
      .mockResolvedValueOnce({ Item: committed })
      .mockResolvedValueOnce({ Items: [{ ...cohort, percentage: 0 }] })
      .mockResolvedValueOnce({ Item: committed });
    const result = await new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO.getById(
      experimentId,
    );
    expect(result.revision).toBe(2);
    expect(result.cohorts.map((row) => row.percentage)).toEqual([0]);
  });

  it("continues scanning after an empty filtered page", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: "USER#first", sk: "META" } })
      .mockResolvedValueOnce({ Items: [] });
    expect(await new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO.list()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].input.ExclusiveStartKey).toEqual({
      pk: "USER#first",
      sk: "META",
    });
  });

  it("ends a cohort query when DynamoDB returns an empty pagination key", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: root })
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: {} })
      .mockResolvedValueOnce({ Item: root });
    const cohorts = await new DynamoDBAdaptor(fakeClient(send), "xp").cohortDAO.getByExperimentId(
      experimentId,
    );
    expect(cohorts).toEqual([]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]![0].constructor.name).toBe("GetCommand");
  });

  it("returns a cursor for sparse raw pages, includes literal name matches and avoids hydrating records", async () => {
    const raw = { pk: "USER#first", sk: "META" };
    const matching = { ...root, name: "Test [Alpha]" };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: raw })
      .mockResolvedValueOnce({ Items: [matching, { ...root, name: "Other" }] });
    const dao = new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO;
    const query = { query: "[ALPHA]", limit: 3 };
    const page = await dao.listPage(query);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await dao.listPage({ ...query, cursor: page.nextCursor! });
    expect(next).toEqual({
      items: [
        {
          name: matching.name,
          slug: root.slug,
          type: root.type,
          enabled: true,
          winner: null,
        },
      ],
      nextCursor: null,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].input).toMatchObject({
      ExclusiveStartKey: raw,
      ConsistentRead: true,
      Limit: 64,
    });
    for (const [command] of send.mock.calls) expect(command.constructor.name).toBe("ScanCommand");
  });

  it("continues at the last returned parent when one raw scan holds more matches than requested", async () => {
    const second = { ...root, pk: "EXP#other", slug: "other" };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [root, second],
        LastEvaluatedKey: { pk: "USER#later", sk: "META" },
      })
      .mockResolvedValueOnce({ Items: [second], LastEvaluatedKey: {} });
    const dao = new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO;
    const first = await dao.listPage({ query: "", limit: 1 });
    const last = await dao.listPage({ query: "", limit: 1, cursor: first.nextCursor! });
    expect(first.items.map((r) => r.slug)).toEqual([root.slug]);
    expect(last.items.map((r) => r.slug)).toEqual(["other"]);
    expect(last.nextCursor).toBeNull();
    expect(send.mock.calls[1]![0].input.ExclusiveStartKey).toEqual({ pk: root.pk, sk: root.sk });
  });

  it("rejects malformed directory continuations before touching the table", async () => {
    const send = vi.fn();
    const dao = new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO;
    for (const cursor of [
      "",
      "!",
      ...["null", "{", "{}", '{"pk":"x","sk":7}', '{"pk":"x","sk":"META","leak":true}'].map(
        (value) => Buffer.from(value).toString("base64url"),
      ),
    ]) {
      await expect(dao.listPage({ query: "", limit: 5, cursor })).rejects.toThrow("cursor");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("ends a scan when DynamoDB returns an empty pagination key", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: {} });
    expect(await new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO.list()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries transaction conflicts but propagates unrelated service failures", async () => {
    const conflict = Object.assign(new Error("conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "TransactionConflict" }],
    });
    const send = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({});
    await new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO.create(experimentInput());
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].input.ClientRequestToken).toBe(
      send.mock.calls[1]![0].input.ClientRequestToken,
    );
    send.mockReset().mockRejectedValue(new Error("credentials expired"));
    await expect(
      new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO.create(experimentInput()),
    ).rejects.toThrow("credentials expired");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("bounds conflict retries", async () => {
    const conflict = Object.assign(new Error("conflict"), { name: "TransactionConflictException" });
    const send = vi.fn().mockRejectedValue(conflict);
    await expect(
      new DynamoDBAdaptor(fakeClient(send), "xp").experimentDAO.create(experimentInput()),
    ).rejects.toThrow("conflict");
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("encodes user ID types unambiguously and rejects non-finite numbers", () => {
    expect(encodeUserId(1)).not.toEqual(encodeUserId("1"));
    expect(encodeUserId("a#b")).not.toEqual(encodeUserId("a"));
    expect(() => encodeUserId(Number.NaN)).toThrow();
    expect(() => encodeUserId(Number.POSITIVE_INFINITY)).toThrow();
  });
});

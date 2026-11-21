import { randomUUID } from "node:crypto";

import type { AnalyticsDestination, CohortJoinedV1, PendingDelivery } from "~/entities/analytics";
import type {
  AnalyticsStore,
  ClaimedDelivery,
  ClaimOptions,
  ClaimRef,
  DeliveryDiagnostics,
  DeliveryFailure,
  DeliveryState,
  DeliverySummary,
  DeliveryTransition,
} from "~/interfaces/analytics";
import type { SequelizeDialect } from "~/interfaces/config";

import type { Row, SqlDatabase, SqlSession } from "./relational";

const bindingsTable = "xp_analytics_destinations";
const deliveriesTable = "xp_analytics_deliveries";

function parameters(session: SqlSession) {
  const values: unknown[] = [];
  return { values, bind: (value: unknown) => session.parameter(values.push(value)) };
}

/** The caller holds the membership transaction and has inserted the membership. */
export async function insertDeliveries(s: SqlSession, deliveries: readonly PendingDelivery[]) {
  const keys = deliveries.map((_, index) => s.parameter(index + 1));
  const bindings = await s.query(
    `SELECT destination_key, provider FROM ${bindingsTable} WHERE destination_key IN (${keys.join(", ")})`,
    deliveries.map(({ destinationKey }) => destinationKey),
  );
  const providers = new Map(bindings.map((row) => [row["destination_key"], row["provider"]]));
  const params = parameters(s);
  const snapshots = deliveries.map(({ event, destinationKey, provider, subjectId }) => {
    if (providers.get(destinationKey) !== provider)
      throw new Error("Analytics destination binding does not match");
    const time = Date.parse(event.occurredAt);
    const values = [
      event.id,
      destinationKey,
      provider,
      subjectId,
      JSON.stringify(event),
      time,
      time,
    ];
    return `(${values.map(params.bind).join(", ")}, 'pending', 0)`;
  });
  await s.query(
    `INSERT INTO ${deliveriesTable}
       (event_id, destination_key, provider, subject_id, event_json, created_at, due_at, state, attempts)
     VALUES ${snapshots.join(", ")}`,
    params.values,
  );
}

/** All interpolated clauses come from the store, except limit which is validated here. */
function selectPage(
  dialect: SequelizeDialect,
  columns: string,
  table: string,
  where: string,
  order: string,
  limit: number,
  lock = false,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError("Analytics page limit must be from 1 to 1000");
  if (dialect === "mssql") {
    const hints = lock ? " WITH (UPDLOCK, READPAST, READCOMMITTEDLOCK)" : "";
    return `SELECT TOP (${limit}) ${columns} FROM ${table}${hints} WHERE ${where} ORDER BY ${order}`;
  }
  return `SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${limit}${lock ? " FOR UPDATE SKIP LOCKED" : ""}`;
}

async function bindDestination(
  s: SqlSession,
  dialect: SequelizeDialect,
  { key, provider }: AnalyticsDestination,
) {
  const keyParam = s.parameter(1);
  const insert = `INSERT INTO ${bindingsTable} (destination_key, provider) VALUES (${keyParam}, ${s.parameter(2)})`;
  const statements = {
    postgres: `${insert} ON CONFLICT (destination_key) DO NOTHING`,
    mysql: `${insert} ON DUPLICATE KEY UPDATE destination_key = destination_key`,
    mssql: `IF NOT EXISTS (SELECT 1 FROM ${bindingsTable} WITH (UPDLOCK, HOLDLOCK) WHERE destination_key = ${keyParam}) ${insert}`,
  };
  await s.query(statements[dialect], [key, provider]);
  const [row] = await s.lock(bindingsTable, `destination_key = ${keyParam}`, [key]);
  if (row?.["provider"] !== provider)
    throw new Error(`Analytics destination "${key}" is bound to a different provider`);
}

async function updateLocked(s: SqlSession, eventId: unknown, destinationKey: string, fields: Row) {
  const params = parameters(s);
  const assignments = Object.entries(fields).map(
    ([key, value]) => `${key} = ${params.bind(value)}`,
  );
  await s.query(
    `UPDATE ${deliveriesTable} SET ${assignments.join(", ")} WHERE event_id = ${params.bind(eventId)} AND destination_key = ${params.bind(destinationKey)}`,
    params.values,
  );
}

export class SqlAnalyticsStore implements AnalyticsStore {
  constructor(private readonly db: SqlDatabase) {}

  ready(destinations: readonly AnalyticsDestination[]) {
    return this.db.transaction(async (s) => {
      try {
        await s.query(`SELECT destination_key, provider FROM ${bindingsTable} WHERE 1 = 0`);
        await s.query(
          `SELECT event_id, destination_key, provider, subject_id, event_json, state, attempts, due_at, lease_token, completed_at, failure_reason, created_at FROM ${deliveriesTable} WHERE 1 = 0`,
        );
      } catch (cause) {
        throw new Error(
          "Analytics storage is unavailable. Run xp setup --analytics and apply the generated migration.",
          { cause },
        );
      }
      // All producers and workers take registry locks in the same order.
      for (const destination of [...destinations].sort((a, b) => a.key.localeCompare(b.key))) {
        await bindDestination(s, this.db.dialect, destination);
      }
    });
  }

  claim(destination: AnalyticsDestination, options: ClaimOptions): Promise<ClaimedDelivery[]> {
    return this.db.transaction(
      async (s) => {
        const p = s.parameter;
        // Each equality on state gives the due index a bounded ordered range.
        // Comparing the two pages keeps abandoned leases from starving new work.
        const candidates: Row[] = [];
        for (const state of ["pending", "claimed"]) {
          const page = await s.query(
            selectPage(
              this.db.dialect,
              "*",
              deliveriesTable,
              `destination_key = ${p(1)} AND provider = ${p(2)} AND state = ${p(3)} AND due_at <= ${p(4)}`,
              "due_at",
              options.limit,
              true,
            ),
            [destination.key, destination.provider, state, options.now],
          );
          candidates.push(...page);
        }
        candidates.sort((left, right) => Number(left["due_at"]) - Number(right["due_at"]));
        const claims: ClaimedDelivery[] = [];
        for (const row of candidates.slice(0, options.limit)) {
          const attempts = Number(row["attempts"]) + 1;
          const leaseToken = randomUUID();
          const leaseUntil = options.now + options.leaseMs;
          await updateLocked(s, row["event_id"], destination.key, {
            state: "claimed",
            attempts,
            lease_token: leaseToken,
            due_at: leaseUntil,
          });
          claims.push({
            event: JSON.parse(String(row["event_json"])) as CohortJoinedV1,
            destinationKey: destination.key,
            provider: destination.provider,
            subjectId: String(row["subject_id"]),
            attempts,
            leaseToken,
            leaseUntil,
          });
        }
        return claims;
        // InnoDB's default repeatable-read gap locks can deadlock while moving a
        // claimed row between index ranges. Row locks suffice for this queue.
      },
      this.db.dialect === "mysql" ? "READ COMMITTED" : undefined,
    );
  }

  private withClaim(ref: ClaimRef, now: number, fields: Row, extendingTo?: number) {
    return this.db.transaction(async (s) => {
      const p = s.parameter;
      const [row] = await s.lock(
        deliveriesTable,
        `event_id = ${p(1)} AND destination_key = ${p(2)} AND state = 'claimed' AND lease_token = ${p(3)} AND due_at > ${p(4)}`,
        [ref.eventId, ref.destinationKey, ref.leaseToken, now],
      );
      if (!row || (extendingTo !== undefined && extendingTo <= Number(row["due_at"]))) return false;
      await updateLocked(s, ref.eventId, ref.destinationKey, fields);
      return true;
    });
  }

  settle(ref: ClaimRef, transition: DeliveryTransition, now: number) {
    return this.withClaim(ref, now, {
      state: transition.state,
      lease_token: null,
      failure_reason: transition.state === "delivered" ? null : transition.reason,
      due_at: transition.state === "pending" ? transition.availableAt : now,
      completed_at: transition.state === "pending" ? null : now,
    });
  }

  renew(ref: ClaimRef, leaseUntil: number, now: number) {
    return this.withClaim(ref, now, { due_at: leaseUntil }, leaseUntil);
  }

  destinations(after: string | null, limit: number) {
    return this.db.read(async (s) => {
      const rows = await s.query(
        selectPage(
          this.db.dialect,
          "destination_key, provider",
          bindingsTable,
          after === null ? "1 = 1" : `destination_key > ${s.parameter(1)}`,
          "destination_key",
          limit,
        ),
        after === null ? [] : [after],
      );
      return rows.map((row) => ({
        key: String(row["destination_key"]),
        provider: String(row["provider"]),
      }));
    });
  }

  inspect(destinationKey: string, state: DeliveryState, limit: number): Promise<DeliverySummary[]> {
    return this.db.read(async (s) => {
      const rows = await s.query(
        selectPage(
          this.db.dialect,
          "event_id, provider, created_at, attempts, failure_reason",
          deliveriesTable,
          `destination_key = ${s.parameter(1)} AND state = ${s.parameter(2)}`,
          "created_at, event_id",
          limit,
        ),
        [destinationKey, state],
      );
      return rows.map((row) => ({
        eventId: String(row["event_id"]),
        destinationKey,
        provider: String(row["provider"]),
        state,
        attempts: Number(row["attempts"]),
        occurredAt: new Date(Number(row["created_at"])).toISOString(),
        reason: row["failure_reason"] as DeliveryFailure | null,
      }));
    });
  }

  diagnostics(destinationKey: string): Promise<DeliveryDiagnostics> {
    return this.db.read(async (s) => {
      const count = this.db.dialect === "mssql" ? "COUNT_BIG(*)" : "COUNT(*)";
      const rows = await s.query(
        `SELECT state, ${count} AS total, MIN(created_at) AS oldest FROM ${deliveriesTable} WHERE destination_key = ${s.parameter(1)} GROUP BY state`,
        [destinationKey],
      );
      const counts = { pending: 0, claimed: 0, delivered: 0, failed: 0 };
      let oldestPendingAt: number | null = null;
      for (const row of rows) {
        const state = row["state"] as DeliveryState;
        counts[state] = Number(row["total"]);
        if (state === "pending" || state === "claimed") {
          const oldest = Number(row["oldest"]);
          oldestPendingAt = oldestPendingAt === null ? oldest : Math.min(oldest, oldestPendingAt);
        }
      }
      return { counts, oldestPendingAt };
    });
  }

  redrive(destinationKey: string, eventId: string, now: number) {
    return this.db.transaction(async (s) => {
      const rows = await s.lock(
        deliveriesTable,
        `event_id = ${s.parameter(1)} AND destination_key = ${s.parameter(2)} AND state = 'failed'`,
        [eventId, destinationKey],
      );
      if (!rows.length) return false;
      await updateLocked(s, eventId, destinationKey, {
        state: "pending",
        attempts: 0,
        due_at: now,
        failure_reason: null,
        completed_at: null,
        lease_token: null,
      });
      return true;
    });
  }

  prune(destinationKey: string, before: number, limit: number) {
    return this.removePage(destinationKey, before, limit, "history");
  }

  purge(destinationKey: string, now: number, limit: number) {
    return this.removePage(destinationKey, now, limit, "queued");
  }

  private removePage(
    destinationKey: string,
    timestamp: number,
    limit: number,
    kind: "history" | "queued",
  ) {
    return this.db.transaction(
      async (s) => {
        const p = s.parameter;
        const condition =
          kind === "history"
            ? `state IN ('delivered','failed') AND completed_at < ${p(2)}`
            : `(state = 'pending' OR (state = 'claimed' AND due_at <= ${p(2)}))`;
        const rows = await s.query(
          selectPage(
            this.db.dialect,
            "event_id",
            deliveriesTable,
            `destination_key = ${p(1)} AND ${condition}`,
            kind === "history" ? "completed_at, event_id" : "due_at, event_id",
            limit,
            true,
          ),
          [destinationKey, timestamp],
        );
        if (rows.length) {
          const ids = rows.map((_, i) => p(i + 2)).join(", ");
          await s.query(
            `DELETE FROM ${deliveriesTable} WHERE destination_key = ${p(1)} AND event_id IN (${ids})`,
            [destinationKey, ...rows.map((row) => row["event_id"])],
          );
        }
        return rows.length;
      },
      this.db.dialect === "mysql" ? "READ COMMITTED" : undefined,
    );
  }
}

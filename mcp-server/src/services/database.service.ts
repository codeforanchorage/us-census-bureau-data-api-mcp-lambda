import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Client, Pool, PoolClient, PoolConfig } from 'pg'

type QueryParam = string | number | boolean | null | Date | Buffer | string[]

const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME

// Postgres error code for a statement cancelled by statement_timeout.
const QUERY_CANCELLED = '57014'

// Driver errors leak schema, credentials and topology ("password
// authentication failed for user ...", relation names, host:port), and the
// tools put error messages straight into tool results a caller sees. Log
// the real error for the operator (console.error survives the DEBUG_LOGS
// suppression) and hand the caller a clean, actionable sentence.
function sanitizeDbError(err: unknown): Error {
  console.error('Database query failed:', err)
  const code = (err as { code?: string })?.code
  if (code === QUERY_CANCELLED) {
    return new Error(
      'The database query timed out. Narrow the query (fewer rows, tighter filters) and retry.',
    )
  }
  return new Error(
    'The database is temporarily unavailable. Retry after a short delay.',
  )
}

export class DatabaseService {
  private static instance: DatabaseService
  private pool: Pool
  private client: Client | null = null

  private constructor() {
    const DATABASE_URL: string =
      process.env.DATABASE_URL ||
      'postgresql://mcp_user:mcp_pass@localhost:5432/mcp_db'

    console.log(
      'DatabaseService initializing with URL:',
      DATABASE_URL.replace(/:[^:@]*@/, ':***@'),
    )

    const poolConfig: PoolConfig = {
      connectionString: DATABASE_URL,
      // On Lambda each warm container handles one request at a time, so a big
      // pool just wastes RDS connections. Locally we keep headroom for tests.
      // Fan-out arithmetic (must hold or load fails as connection refusal,
      // not slowness): lambda_reserved_concurrency (40, prod.tfvars) x this
      // max (2) = 80 connections, under the db.t4g.micro ~87 ceiling.
      max: isLambda ? 2 : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: isLambda ? 5000 : 2000,
      // Bottom rung of the timeout ladder (tightest at the bottom):
      //   API Gateway  29s  hard, non-adjustable
      //   Lambda       28s  prod.tfvars lambda_timeout
      //   statement    20s  this -- leaves ~8s to format and return
      // Without it a runaway query held its connection until the Lambda was
      // killed, and the pool only reclaimed it when it next noticed.
      // Observed prod max duration is 3.3s over 30 days, so 20s cuts
      // nothing legitimate. Server-side (Postgres statement_timeout), so
      // the query dies in the database, not just in the client.
      statement_timeout: 20_000,
    }

    if (isLambda) {
      // The RDS instance is publicly accessible, so the TLS peer must be
      // verified — an unvalidated cert leaves the master password open to
      // MITM. The AWS RDS CA bundle ships in the deployment zip at certs/
      // (see scripts/deploy.sh); fail closed if it's missing.
      poolConfig.ssl = {
        rejectUnauthorized: true,
        ca: readFileSync(
          join(
            process.env.LAMBDA_TASK_ROOT ?? process.cwd(),
            'certs/rds-global-bundle.pem',
          ),
          'utf8',
        ),
      }
    }

    this.pool = new Pool(poolConfig)
  }

  // Get singleton instance
  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService()
    }
    return DatabaseService.instance
  }

  // Get a client from the pool for a single query
  public async getClient(): Promise<PoolClient> {
    return await this.pool.connect()
  }

  // Execute a single query using a pooled connection. Driver errors are
  // sanitized (and logged in full) before they can reach a tool result.
  public async query<T = unknown>(
    text: string,
    params?: QueryParam[],
  ): Promise<{ rows: T[] }> {
    let client: PoolClient
    try {
      client = await this.pool.connect()
    } catch (err) {
      throw sanitizeDbError(err)
    }
    try {
      const result = await client.query(text, params)
      return result
    } catch (err) {
      throw sanitizeDbError(err)
    } finally {
      client.release() // Return client to pool
    }
  }

  // Get a persistent client connection. Call releaseClient() when done
  public async getPersistentClient(): Promise<Client> {
    if (!this.client) {
      const databaseUrl =
        process.env.DATABASE_URL ||
        'postgresql://mcp_user:mcp_pass@localhost:5432/mcp_db'
      this.client = new Client({ connectionString: databaseUrl })
      await this.client.connect()
    }
    return this.client
  }

  // Release the persistent client connection
  public async releasePersistentClient(): Promise<void> {
    if (this.client) {
      await this.client.end()
      this.client = null
    }
  }

  // Execute multiple queries in a transaction
  public async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // Database Health
  public async healthCheck(): Promise<boolean> {
    try {
      const result = await this.query('SELECT 1 as health')
      return result.rows.length > 0
    } catch {
      return false
    }
  }

  // Close Connections
  public async cleanup(): Promise<void> {
    await this.releasePersistentClient()
    await this.pool.end()
  }
}

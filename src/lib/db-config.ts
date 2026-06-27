export function createMariaDbPoolConfig(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const socketPath = url.searchParams.get("socketPath") ?? undefined;

  return {
    host: socketPath ? undefined : url.hostname,
    port: socketPath ? undefined : Number(url.port || 3306),
    socketPath,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 5),
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 15000),
    acquireTimeout: Number(process.env.DB_ACQUIRE_TIMEOUT_MS ?? 15000),
    idleTimeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS ?? 60)
  };
}

export type SheetDataSource = "sql" | "rtdb";

export function getSheetDataSource(): SheetDataSource {
  const rawValue = (
    process.env.SHEET_DATA_SOURCE ??
    process.env.DATA_SOURCE ??
    ""
  ).trim().toLowerCase();

  return rawValue === "rtdb" || rawValue === "realtime-database" ? "rtdb" : "sql";
}

export function isRealtimeDatabaseSource(): boolean {
  return getSheetDataSource() === "rtdb";
}

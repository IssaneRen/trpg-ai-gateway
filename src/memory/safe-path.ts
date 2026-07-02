export function assertSafeSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

export function assertSafeJsonFileName(value: string): string {
  if (!/^[a-zA-Z0-9._-]+\.json$/.test(value)) {
    throw new Error(`wiki file name contains unsupported characters: ${value}`);
  }
  return value;
}

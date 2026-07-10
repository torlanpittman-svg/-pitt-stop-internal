export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

interface LogEntry {
  level: LogLevel
  module: string
  event: string
  timestamp: string
  data?: unknown
}

function log(level: LogLevel, module: string, event: string, data?: unknown): void {
  const entry: LogEntry = {
    level,
    module,
    event,
    timestamp: new Date().toISOString(),
    ...(data !== undefined && { data }),
  }
  const line = JSON.stringify(entry)
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export const logger = {
  info:  (module: string, event: string, data?: unknown) => log('info',  module, event, data),
  warn:  (module: string, event: string, data?: unknown) => log('warn',  module, event, data),
  error: (module: string, event: string, data?: unknown) => log('error', module, event, data),
  debug: (module: string, event: string, data?: unknown) => log('debug', module, event, data),
}

/*
  Pulled from https://github.com/winstonjs/winston/issues/1427 with some edits.
*/

const { createLogger, format, transports } = require('winston');
const { inspect } = require('util');

function isPrimitive(val) {
  return val === null || (typeof val !== 'object' && typeof val !== 'function');
}

function formatWithInspect(val) {
  const prefix = isPrimitive(val) ? '' : '\n';
  const shouldFormat = typeof val !== 'string';

  return prefix + (shouldFormat ? inspect(val, { depth: null, colors: true }) : val);
}

let logLevel = 'debug';

/**
 * Set a log level. Options are (in order of priority)
 * error, warn, info, verbose, debug, silly.
 *
 * Setting a log level of 'info' for example will log out error, warn, and info logs, but ignore debug and silly logs.
 *
 * @param {String} newLevel
 */
export function setLogLevel(newLevel) {
  logLevel = newLevel;
}

export default createLogger({
  level: logLevel,
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.colorize(),
    format.printf(info => {
      const msg = formatWithInspect(info.message);
      const splatArgs = info[Symbol.for('splat')] || [];
      const rest = splatArgs.map(data => formatWithInspect(data)).join(' ');

      return `${info.level}: ${msg} ${rest}`;
    }),
  ),
  transports: [new transports.Console()],
});

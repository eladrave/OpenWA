import { HttpException, HttpStatus } from '@nestjs/common';

export type MonitorErrorCode =
  | 'AUTH_REQUIRED'
  | 'SESSION_NOT_READY'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_RENAMED'
  | 'GROUP_NOT_MONITORED'
  | 'RULE_NOT_FOUND'
  | 'RULE_INVALID'
  | 'RULE_LIMIT'
  | 'SEMANTIC_UNAVAILABLE'
  | 'CURSOR_CONFLICT'
  | 'CURSOR_NOT_FOUND'
  | 'FLOW_NOT_FOUND'
  | 'FLOW_EXPIRED'
  | 'FLOW_CONFLICT'
  | 'CHALLENGE_NOT_READY'
  | 'PAIRING_UNSUPPORTED'
  | 'DISCONNECT_FAILED';

export function monitorError(code: MonitorErrorCode, status: HttpStatus, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

import { AxiosError } from 'axios';

export type ApiResponseStatus = 'NA' | 'SUCCESS' | 'FAIL' | 'TIMEOUT';

/** A non-fatal problem on an otherwise SUCCESS response (e.g. `index_sync_failed`). */
export interface ApiWarning {
  error_code: string;
  message: string;
  [key: string]: unknown;
}

export interface ApiResponse<T> {
  status: ApiResponseStatus;
  message?: string;
  data?: T;
  /** Present only when the backend has something non-fatal to report. */
  warnings?: ApiWarning[];
}

export interface ApiSuccessResponse<T> extends ApiResponse<T> {
  status: 'SUCCESS';
  message: string;
}

export interface ApiFailResponse<T> extends ApiResponse<T> {
  status: 'FAIL';
  message: string;
}

export type ApiError = AxiosError<ApiFailResponse<string>>;

export function isApiError(error: any): error is ApiError {
  return error instanceof AxiosError && error.response?.data?.status === 'FAIL';
}

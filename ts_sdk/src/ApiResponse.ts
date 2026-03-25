import { AxiosError } from 'axios';

export type ApiResponseStatus = 'NA' | 'SUCCESS' | 'FAIL' | 'TIMEOUT';

export interface ApiResponse<T> {
  status: ApiResponseStatus;
  message?: string;
  data?: T;
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

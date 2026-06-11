import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { ApiFailResponse } from './ApiResponse';
import { alert } from './alert';
import { APIStats } from './apiStats';
import config from './config';
import { getTraceId } from './trace';

//@ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function generateCurlCommand(request: AxiosRequestConfig) {
  // eslint-disable-next-line prefer-const
  let { method, url, data, headers } = request;
  if (!method) {
    method = 'GET'; // Default to 'GET' if no method is specified
  } else {
    method = method.toUpperCase();
  }
  let curlCmd = `curl -X ${method} "${config.SERVER_URL}${url}"`;

  // Include headers, if any
  if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      curlCmd += ` -H "${key}: ${value}"`;
    });
  }

  // Include request body data, if any. Assuming JSON format here.
  if (data) {
    if (typeof data === 'object') {
      // If data is an object, stringify it
      data = JSON.stringify(data);
    }
    curlCmd += ` --data-raw '${data}'`;
  }

  return curlCmd;
}

export const GRAPH_API_PREFIX = config.API_PREFIXES.graph;

export const CURRENT_USER = config.API_PREFIXES.currentUser;

export const apiStats = new APIStats();

export function clearStats() {
  apiStats.reset();
}

export type ExecutionContext = 'browser' | 'node';

export type ApiAxiosInstance = AxiosInstance;

export const invalidTokenMessage = 'Invalid token, login required';
export const invalidRefreshTokenMessage = 'Invalid refresh token, login required';

// Extended client interface for test token support
interface ExtendedApiClient extends ApiAxiosInstance {
  testUserToken?: string;
}

function initApiClient(client: ApiAxiosInstance) {
  client.interceptors.request.use(
    function (request) {
      apiStats.incrementTotal();
      const method = request.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementInFlight(method);

      // Add Authorization header for test user token if set (for API tests in jsdom environment)
      // This ensures reliable test authentication while keeping cookies for browser operations
      const extendedClient = client as ExtendedApiClient;
      if (extendedClient.testUserToken && !request.headers?.['Authorization']) {
        request.headers = request.headers || {};
        request.headers['Authorization'] = `Bearer ${extendedClient.testUserToken}`;
      }

      // Cross-process correlation: stamp every backend call with the renderer's
      // trace id so the backend log lines for this request join back here.
      request.headers = request.headers || {};
      if (!request.headers['X-Trace-Id']) {
        request.headers['X-Trace-Id'] = getTraceId();
      }

      return request;
    },
    function (error) {
      const method = error.config?.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementFailed(method);
      // Do something with request error
      return Promise.reject(error as Error);
    },
  );

  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const method = response.config?.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementSuccessful(method);
      // Any status code that lie within the range of 2xx cause this function to trigger
      // Do something with response data
      return response.data.data;
      //return response;
    },
    (error) => {
      // Any status codes that falls outside the range of 2xx cause this function to trigger
      // Do something with response error
      const method = error.config?.method?.toUpperCase() || 'UNKNOWN';
      apiStats.incrementFailed(method);

      // Check for network errors (backend unavailable)
      if (error.code === 'ERR_NETWORK' || error.code === 'ERR_CONNECTION_REFUSED' || !error.response) {
        console.log('API call error: Service Unavailable - Backend server is not responding');
        // Add a custom flag to identify service unavailable errors
        error.isServiceUnavailable = true;
        error.status = 503; // Service Unavailable HTTP status code
        throw error;
      }

      const msg = error.response?.data?.detail || error.response?.data?.message || error.message;
      if (error.response?.status === 422) {
        throw error;
      }
      // Don't log 404s - callers handle "not found" gracefully
      if (error.response?.status !== 404) {
        console.log('API call error:', msg);
      }
      if (error.response?.status === 401) {
        alert(error.response.statusText, msg, 'warning');
      }
      throw error;
      //return Promise.reject(error);
    },
  );
}

export function getApiClient(): ApiAxiosInstance {
  const conf = config;
  const client: ApiAxiosInstance = axios.create({
    headers: { Accept: 'application/json' },
    baseURL: conf.SERVER_URL,
    withCredentials: true,
    validateStatus: (status) => {
      return (status >= 200 && status < 300) || status == 302 || status == 307; // Custom validation: allow 2xx and 3xx
    },
  });
  initApiClient(client);
  return client;
}

export function getErrorMessages(error: AxiosError): string {
  // Axios error handling
  if (error.response) {
    // Server response was received but indicates an error
    console.error('Error status:', error.response.status, 'data: ', error.response.data);
    if (error.response.data) {
      const response = error.response.data as ApiFailResponse<string>;
      if (response.status === 'FAIL') return response.message;
      else return response.message || error.message;
    }
  } else if (error.request) {
    // Request was made but no response was received
    console.error('No response received for the request.');
    return '';
  } else {
    // An error occurred in setting up the request
    console.error('Error message:', error.message);
    return '';
  }
  return '';
}

export const apiClient = getApiClient(); // Initialize the default API client

export default apiClient;

// For playwright client global variable
//@ts-ignore
window['client'] = apiClient;

// Note: HttpMethod type is exported from models/ApiUrl.ts
export class APIStats {
  totalRequests: number;
  successfulRequests: { [method: string]: number };
  failedRequests: { [method: string]: number };
  inFlightRequests: { [method: string]: number };
  streamingRequests: number;

  constructor(props?: Partial<APIStats>) {
    this.totalRequests = props?.totalRequests || 0;
    this.successfulRequests = props?.successfulRequests || {};
    this.failedRequests = props?.failedRequests || {};
    this.inFlightRequests = props?.inFlightRequests || {};
    this.streamingRequests = props?.streamingRequests || 0;
  }

  clone() {
    return new APIStats({
      totalRequests: this.totalRequests,
      successfulRequests: { ...this.successfulRequests },
      failedRequests: { ...this.failedRequests },
      inFlightRequests: { ...this.inFlightRequests },
      streamingRequests: this.streamingRequests,
    });
  }

  delta(from: APIStats) {
    const deltaSuccessful: { [method: string]: number } = {};
    const deltaFailed: { [method: string]: number } = {};

    // Calculate delta for successful requests
    for (const method in this.successfulRequests) {
      deltaSuccessful[method] = (this.successfulRequests[method] || 0) - (from.successfulRequests[method] || 0);
    }

    // Calculate delta for failed requests
    for (const method in this.failedRequests) {
      deltaFailed[method] = (this.failedRequests[method] || 0) - (from.failedRequests[method] || 0);
    }

    return new APIStats({
      totalRequests: this.totalRequests - from.totalRequests,
      successfulRequests: deltaSuccessful,
      failedRequests: deltaFailed,
      streamingRequests: this.streamingRequests - from.streamingRequests,
    });
  }

  reset() {
    this.totalRequests = 0;
    this.successfulRequests = {};
    this.failedRequests = {};
    this.inFlightRequests = {};
    this.streamingRequests = 0;
  }

  incrementTotal() {
    this.totalRequests++;
  }

  incrementInFlight(method: string) {
    this.inFlightRequests[method] = (this.inFlightRequests[method] || 0) + 1;
  }

  decrementInFlight(method: string) {
    if (this.inFlightRequests[method] > 0) {
      this.inFlightRequests[method]--;
      if (this.inFlightRequests[method] === 0) {
        delete this.inFlightRequests[method];
      }
    }
  }

  incrementSuccessful(method: string) {
    this.decrementInFlight(method);
    this.successfulRequests[method] = (this.successfulRequests[method] || 0) + 1;
  }

  incrementFailed(method: string) {
    this.decrementInFlight(method);
    this.failedRequests[method] = (this.failedRequests[method] || 0) + 1;
  }

  getInFlightByMethod(method: string): number {
    return this.inFlightRequests[method] || 0;
  }

  get totalInFlightRequests(): number {
    return Object.values(this.inFlightRequests).reduce((sum, count) => sum + count, 0);
  }

  // Exposed properties for easy access
  get successfulGET(): number {
    return this.successfulRequests['GET'] || 0;
  }

  get successfulPOST(): number {
    return this.successfulRequests['POST'] || 0;
  }

  get successfulPUT(): number {
    return this.successfulRequests['PUT'] || 0;
  }

  get successfulDELETE(): number {
    return this.successfulRequests['DELETE'] || 0;
  }

  get successfulPATCH(): number {
    return this.successfulRequests['PATCH'] || 0;
  }

  get failedGET(): number {
    return this.failedRequests['GET'] || 0;
  }

  get failedPOST(): number {
    return this.failedRequests['POST'] || 0;
  }

  get failedPUT(): number {
    return this.failedRequests['PUT'] || 0;
  }

  get failedDELETE(): number {
    return this.failedRequests['DELETE'] || 0;
  }

  get failedPATCH(): number {
    return this.failedRequests['PATCH'] || 0;
  }

  get totalSuccessfulRequests(): number {
    return Object.values(this.successfulRequests).reduce((sum, count) => sum + count, 0);
  }

  get totalFailedRequests(): number {
    return Object.values(this.failedRequests).reduce((sum, count) => sum + count, 0);
  }

  getSuccessfulByMethod(method: string): number {
    return this.successfulRequests[method] || 0;
  }

  getFailedByMethod(method: string): number {
    return this.failedRequests[method] || 0;
  }

  print(title: string = 'API Statistics') {
    console.log(`\n📊 ${title}`);
    console.log('═'.repeat(50));
    console.log(`📈 Total Requests: ${this.totalRequests}`);
    console.log(`🌊 Streaming Requests: ${this.streamingRequests}`);
    console.log(`✅ Total Successful: ${this.totalSuccessfulRequests}`);
    console.log(`❌ Total Failed: ${this.totalFailedRequests}`);

    if (this.totalRequests > 0) {
      const successRate = ((this.totalSuccessfulRequests / this.totalRequests) * 100).toFixed(1);
      console.log(`📊 Success Rate: ${successRate}%`);
    }

    // Successful requests by method
    const successfulMethods = Object.keys(this.successfulRequests).filter(
      (method) => this.successfulRequests[method] > 0,
    );
    if (successfulMethods.length > 0) {
      console.log('\n✅ Successful Requests by Method:');
      successfulMethods.forEach((method) => {
        console.log(`   ${method}: ${this.successfulRequests[method]}`);
      });
    }

    // Failed requests by method
    const failedMethods = Object.keys(this.failedRequests).filter((method) => this.failedRequests[method] > 0);
    if (failedMethods.length > 0) {
      console.log('\n❌ Failed Requests by Method:');
      failedMethods.forEach((method) => {
        console.log(`   ${method}: ${this.failedRequests[method]}`);
      });
    }

    console.log('═'.repeat(50));
  }
}

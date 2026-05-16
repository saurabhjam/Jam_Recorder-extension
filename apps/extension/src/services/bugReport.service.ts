/**
 * Bug Report Service
 * Captures browser metadata, console logs, network logs, and assembles bug reports.
 */

export interface BrowserInfo {
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  screenResolution: string;
  viewport: string;
  userAgent: string;
  language: string;
  timezone: string;
  cookiesEnabled: boolean;
  doNotTrack: boolean;
  url: string;
  title: string;
}

export interface ConsoleLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  args: string[];
  timestamp: number;
  url?: string;
}

export interface NetworkLog {
  method: string;
  url: string;
  status: number;
  statusText: string;
  duration: number;
  requestHeaders?: Record<string, string>;
  responseSize?: number;
  initiatorType: string;
  timestamp: number;
  failed?: boolean;
}

export interface BugReport {
  id: string;
  title: string;
  description: string;
  screenshotUrl: string | null;
  annotatedScreenshotUrl: string | null;
  browserInfo: BrowserInfo;
  consoleLogs: ConsoleLog[];
  networkLogs: NetworkLog[];
  createdAt: string;
}

class BugReportService {
  private consoleLogs: ConsoleLog[] = [];
  private networkLogs: NetworkLog[] = [];
  private readonly MAX_LOGS = 100;

  getBrowserInfo(): BrowserInfo {
    const ua = navigator.userAgent;

    const detectBrowser = () => {
      if (ua.includes('Edg/'))
        return { name: 'Edge', version: ua.match(/Edg\/([\d.]+)/)?.[1] ?? 'unknown' };
      if (ua.includes('Chrome/'))
        return { name: 'Chrome', version: ua.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown' };
      if (ua.includes('Firefox/'))
        return { name: 'Firefox', version: ua.match(/Firefox\/([\d.]+)/)?.[1] ?? 'unknown' };
      if (ua.includes('Safari/') && !ua.includes('Chrome'))
        return { name: 'Safari', version: ua.match(/Version\/([\d.]+)/)?.[1] ?? 'unknown' };
      return { name: 'Unknown', version: 'unknown' };
    };

    const detectOS = () => {
      if (ua.includes('Windows NT 10')) return { name: 'Windows', version: '10/11' };
      if (ua.includes('Windows NT 6.3')) return { name: 'Windows', version: '8.1' };
      if (ua.includes('Mac OS X')) {
        const match = ua.match(/Mac OS X ([\d_]+)/);
        return { name: 'macOS', version: match?.[1]?.replace(/_/g, '.') ?? 'unknown' };
      }
      if (ua.includes('Linux')) return { name: 'Linux', version: 'unknown' };
      if (ua.includes('Android')) {
        const match = ua.match(/Android ([\d.]+)/);
        return { name: 'Android', version: match?.[1] ?? 'unknown' };
      }
      if (ua.includes('iPhone') || ua.includes('iPad')) return { name: 'iOS', version: 'unknown' };
      return { name: 'Unknown', version: 'unknown' };
    };

    const browser = detectBrowser();
    const os = detectOS();

    return {
      browser: browser.name,
      browserVersion: browser.version,
      os: os.name,
      osVersion: os.version,
      screenResolution: `${screen.width}x${screen.height}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      userAgent: ua,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cookiesEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack === '1',
      url: window.location.href,
      title: document.title,
    };
  }

  startCapturingConsoleLogs(): void {
    const originalConsole = { ...console };

    (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) => {
      (console as Record<string, unknown>)[level] = (...args: unknown[]) => {
        // Call original
        (originalConsole[level] as (...a: unknown[]) => void)(...args);

        // Capture
        this.consoleLogs.unshift({
          level,
          args: args.map((a) => {
            try {
              return typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a);
            } catch {
              return '[Unserializable]';
            }
          }),
          timestamp: Date.now(),
          url: window.location.href,
        });

        // Keep only last MAX_LOGS
        if (this.consoleLogs.length > this.MAX_LOGS) {
          this.consoleLogs = this.consoleLogs.slice(0, this.MAX_LOGS);
        }
      };
    });

    // Capture unhandled errors
    window.addEventListener('error', (event) => {
      this.consoleLogs.unshift({
        level: 'error',
        args: [`${event.message} (${event.filename}:${event.lineno}:${event.colno})`],
        timestamp: Date.now(),
        url: window.location.href,
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      this.consoleLogs.unshift({
        level: 'error',
        args: [`Unhandled Promise Rejection: ${String(event.reason)}`],
        timestamp: Date.now(),
        url: window.location.href,
      });
    });
  }

  startCapturingNetworkLogs(): void {
    // Intercept fetch
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const start = Date.now();

      try {
        const response = await originalFetch(input, init);
        this.networkLogs.unshift({
          method: method.toUpperCase(),
          url,
          status: response.status,
          statusText: response.statusText,
          duration: Date.now() - start,
          initiatorType: 'fetch',
          timestamp: start,
        });

        if (this.networkLogs.length > this.MAX_LOGS) {
          this.networkLogs = this.networkLogs.slice(0, this.MAX_LOGS);
        }

        return response;
      } catch (err) {
        this.networkLogs.unshift({
          method: method.toUpperCase(),
          url,
          status: 0,
          statusText: 'Network Error',
          duration: Date.now() - start,
          initiatorType: 'fetch',
          timestamp: start,
          failed: true,
        });
        throw err;
      }
    };

    // Intercept XHR
    const OriginalXHR = window.XMLHttpRequest;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    class InterceptedXHR extends OriginalXHR {
      private _method: string = 'GET';
      private _url: string = '';
      private _start: number = 0;

      open(method: string, url: string, ...rest: unknown[]) {
        this._method = method;
        this._url = url;
        this._start = Date.now();
        super.open(method, url, ...(rest as [boolean?, string?, string?]));
      }

      send(body?: Document | XMLHttpRequestBodyInit | null) {
        this.addEventListener('loadend', () => {
          self.networkLogs.unshift({
            method: this._method.toUpperCase(),
            url: this._url,
            status: this.status,
            statusText: this.statusText,
            duration: Date.now() - this._start,
            initiatorType: 'xhr',
            timestamp: this._start,
            failed: this.status === 0,
          });

          if (self.networkLogs.length > self['MAX_LOGS']) {
            self.networkLogs = self.networkLogs.slice(0, self['MAX_LOGS']);
          }
        });
        super.send(body);
      }
    }
    window.XMLHttpRequest = InterceptedXHR;
  }

  getConsoleLogs(limit = 50): ConsoleLog[] {
    return this.consoleLogs.slice(0, limit);
  }

  getNetworkLogs(limit = 50): NetworkLog[] {
    return this.networkLogs.slice(0, limit);
  }

  clearLogs(): void {
    this.consoleLogs = [];
    this.networkLogs = [];
  }

  async captureScreenshot(): Promise<string> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.dataUrl) {
          resolve(response.dataUrl as string);
        } else {
          reject(new Error('Screenshot failed'));
        }
      });
    });
  }
}

export const bugReportService = new BugReportService();

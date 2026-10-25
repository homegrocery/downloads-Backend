import type { Request, Response, NextFunction } from 'express';

interface RequestLog {
  count: number;
  resetTime: number;
}

const ipRequestMap = new Map<string, RequestLog>();

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (process.env.NODE_ENV === 'test') {
      return next();
    }

    const key = options.keyGenerator ? options.keyGenerator(req) : (req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const clientRecord = ipRequestMap.get(key);

    if (!clientRecord || clientRecord.resetTime < now) {
      ipRequestMap.set(key, {
        count: 1,
        resetTime: now + options.windowMs
      });
      return next();
    }

    if (clientRecord.count >= options.maxRequests) {
      const waitSeconds = Math.ceil((clientRecord.resetTime - now) / 1000);
      res.status(429).json({
        success: false,
        error: `RATE_LIMITED: Too many requests. Please wait ${waitSeconds} seconds.`,
        errorMr: `खूप जास्त विनंत्या पाठवल्या आहेत. कृपया ${waitSeconds} सेकंद प्रतीक्षा करा.`
      });
      return;
    }

    clientRecord.count++;
    next();
  };
}

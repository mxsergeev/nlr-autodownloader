import { config } from "./config.js";

export const redisOptions = {
  ...config.redis,
  maxRetriesPerRequest: null,
};

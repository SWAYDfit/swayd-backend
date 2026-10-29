import dotenv from "dotenv";
dotenv.config({ quiet: true });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing environment variable " + name + ". See .env.example.");
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  ownerEmail: (process.env.OWNER_EMAIL || "").trim().toLowerCase(),
  corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  tz: process.env.APP_TZ || "Australia/Melbourne",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicBase: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  anthropicModelFast: process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-5-5",
  storage: process.env.STORAGE || "disk",
  uploadDir: process.env.UPLOAD_DIR || "./uploads",
  s3: {
    endpoint: process.env.S3_ENDPOINT || "",
    bucket: process.env.S3_BUCKET || "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    region: process.env.S3_REGION || "auto"
  },
  sandbox: process.env.SANDBOX === "true",
  consentVersion: "2026-10"
};
if (config.jwtSecret.length < 32 && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET must be at least 32 characters in production.");
}

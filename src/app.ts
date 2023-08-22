import qrcode from "qrcode-terminal";
import { Client, LocalAuth } from "whatsapp-web.js";
import amqp from "amqplib";
import { config } from "dotenv";
import winston from "winston";
import moment from "moment-timezone";

config();

const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => {
        return moment().tz(systemTimeZone).format("YYYY-MM-DD HH:mm:ss");
      },
    }),
    winston.format.prettyPrint()
  ),
  defaultMeta: { service: process.env.SERVICE_NAME! },
  transports: [new winston.transports.Console()],
});

interface Job {
  to: string;
  msg: string;
}

let connection: amqp.Connection;
let channel: amqp.Channel;
let waReady: boolean = false;
let lastProcessedTimeStamp: number = Date.now();

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox"] },
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  waReady = true;
  logger.info("Client is ready!");
});

client.on("error", (error) => {
  logger.error(`WhatsApp Error: ${error.message}`);
});

client.initialize();

async function main(): Promise<void> {
  try {
    connection = await amqp.connect(process.env.AMQP_URL!);
    connection.on("error", (error: Error) => {
      logger.error(`AMQP error: ${error.message}`);
      reconnectAfterDelay(main);
    });
    connection.on("close", () => {
      logger.warn("AMQP connection closed");
      reconnectAfterDelay(main);
    });
    channel = await connection.createChannel();
    await channel.assertQueue(process.env.JOB_QUEUE!, { durable: true });
    channel.prefetch(1);
    channel.consume(process.env.JOB_QUEUE!, processMessage);
  } catch (error: any) {
    logger.error(`AMQP error: ${error.message}`);
    reconnectAfterDelay(main);
  }
}

async function processMessage(message: amqp.Message | null): Promise<void> {
  if (!message) return;

  const job: Job = JSON.parse(message.content.toString());
  const now = Date.now();
  const elapsed = now - lastProcessedTimeStamp;

  if (elapsed < +process.env.RATE_LIMIT_TIME_MS!) {
    const delay = +process.env.RATE_LIMIT_TIME_MS! - elapsed;
    setTimeout(async () => {
      const proceed = await processJob(job);
      handleJobOutcome(proceed, message);
    }, delay);
    return;
  }

  const proceed = await processJob(job);
  handleJobOutcome(proceed, message);
}

function handleJobOutcome(proceed: boolean, message: amqp.Message): void {
  if (proceed) {
    channel.ack(message);
  } else {
    channel.nack(message);
  }
}

function reconnectAfterDelay(func: () => void, delay: number = 1000): void {
  logger.info("Reconnecting...");
  setTimeout(func, delay);
}

async function processJob(job: Job): Promise<boolean> {
  if (!waReady) {
    logger.warn("WhatsApp client is not ready.");
    return false;
  }

  const to = job.to.endsWith(".us") ? job.to : job.to + "@c.us";

  try {
    if (to.endsWith("@c.us") && !(await client.isRegisteredUser(to))) {
      logger.error(`${to} is not registered.`);
      return true;
    }

    await client.sendMessage(to, job.msg);
    logger.info("Message sent successfully", job);
    return true;
  } catch (error: any) {
    logger.error(`Failed to send message: ${error.message}`);
    return false;
  }
}

main();

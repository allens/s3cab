import { randomBytes } from "crypto";
import { createWriteStream } from "fs";

const filePath = "./test/zblob.bin";
const fileSize = 100 * 1024 * 1024; // Size in bytes
const chunkSize = 64 * 1024; // 64 KB chunks

const stream = createWriteStream(filePath);

function writeRandomData(size) {
  return new Promise((resolve) => {
    const writeChunk = () => {
      if (size <= 0) {
        stream.end();
        resolve();
        return;
      }

      const chunk = randomBytes(Math.min(chunkSize, size));
      size -= chunk.length;

      if (!stream.write(chunk)) {
        stream.once("drain", writeChunk);
      } else {
        writeChunk();
      }
    };

    writeChunk();
  });
}

writeRandomData(fileSize)
  .then(() => {
    console.log(`File created: ${filePath}`);
  })
  .catch((error) => {
    console.error(`Error creating file: ${error.message}`);
  });

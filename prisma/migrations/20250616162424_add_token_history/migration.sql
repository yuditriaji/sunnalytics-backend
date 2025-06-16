-- CreateTable
CREATE TABLE "TokenHistory" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "marketCap" DOUBLE PRECISION,
    "volume24h" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenHistory_tokenId_timestamp_idx" ON "TokenHistory"("tokenId", "timestamp");

-- AddForeignKey
ALTER TABLE "TokenHistory" ADD CONSTRAINT "TokenHistory_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

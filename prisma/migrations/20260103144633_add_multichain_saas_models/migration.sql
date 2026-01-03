/*
  Warnings:

  - You are about to drop the column `platform` on the `Token` table. All the data in the column will be lost.
  - You are about to drop the column `platform` on the `TokenDetail` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[coingeckoId]` on the table `Token` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[chain,contractAddress]` on the table `Token` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[chain,contractAddress]` on the table `TokenDetail` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tokenId,interval,timestamp]` on the table `TokenHistory` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `chain` to the `TokenDetail` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Token_exchange_idx";

-- DropIndex
DROP INDEX "Token_symbol_key";

-- DropIndex
DROP INDEX "TokenHistory_tokenId_timestamp_idx";

-- AlterTable
ALTER TABLE "Token" DROP COLUMN "platform",
ADD COLUMN     "chain" TEXT NOT NULL DEFAULT 'solana',
ADD COLUMN     "circulatingSupply" DOUBLE PRECISION,
ADD COLUMN     "coingeckoId" TEXT,
ADD COLUMN     "dataSource" TEXT,
ADD COLUMN     "fdv" DOUBLE PRECISION,
ADD COLUMN     "lastPriceUpdate" TIMESTAMP(3),
ADD COLUMN     "maxSupply" DOUBLE PRECISION,
ADD COLUMN     "priceChange7d" DOUBLE PRECISION,
ADD COLUMN     "totalSupply" DOUBLE PRECISION,
ADD COLUMN     "volumeMarketCapRatio" DOUBLE PRECISION,
ALTER COLUMN "category" SET DEFAULT 'altcoin';

-- AlterTable
ALTER TABLE "TokenDetail" DROP COLUMN "platform",
ADD COLUMN     "chain" TEXT NOT NULL,
ADD COLUMN     "holderCount" INTEGER,
ADD COLUMN     "top10HolderPercent" DOUBLE PRECISION,
ADD COLUMN     "whaleTransactions24h" INTEGER;

-- AlterTable
ALTER TABLE "TokenExchange" ADD COLUMN     "ask" DOUBLE PRECISION,
ADD COLUMN     "bid" DOUBLE PRECISION,
ADD COLUMN     "spread" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "TokenHeader" ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "twitter" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "TokenHistory" ADD COLUMN     "close" DOUBLE PRECISION,
ADD COLUMN     "high" DOUBLE PRECISION,
ADD COLUMN     "interval" TEXT NOT NULL DEFAULT '1h',
ADD COLUMN     "low" DOUBLE PRECISION,
ADD COLUMN     "open" DOUBLE PRECISION,
ADD COLUMN     "volume" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "chains" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nativeToken" TEXT NOT NULL,
    "rpcUrl" TEXT,
    "explorerUrl" TEXT,
    "dexScreenerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "channels" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggeredAt" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_source_health" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "lastCheck" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccess" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "avgLatencyMs" INTEGER,
    "errorMessage" TEXT,

    CONSTRAINT "data_source_health_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_userId_isActive_idx" ON "Alert"("userId", "isActive");

-- CreateIndex
CREATE INDEX "Alert_tokenId_idx" ON "Alert"("tokenId");

-- CreateIndex
CREATE INDEX "Alert_alertType_idx" ON "Alert"("alertType");

-- CreateIndex
CREATE UNIQUE INDEX "Token_coingeckoId_key" ON "Token"("coingeckoId");

-- CreateIndex
CREATE INDEX "Token_chain_idx" ON "Token"("chain");

-- CreateIndex
CREATE INDEX "Token_category_idx" ON "Token"("category");

-- CreateIndex
CREATE INDEX "Token_coingeckoId_idx" ON "Token"("coingeckoId");

-- CreateIndex
CREATE UNIQUE INDEX "Token_chain_contractAddress_key" ON "Token"("chain", "contractAddress");

-- CreateIndex
CREATE INDEX "TokenDetail_symbol_idx" ON "TokenDetail"("symbol");

-- CreateIndex
CREATE INDEX "TokenDetail_chain_idx" ON "TokenDetail"("chain");

-- CreateIndex
CREATE UNIQUE INDEX "TokenDetail_chain_contractAddress_key" ON "TokenDetail"("chain", "contractAddress");

-- CreateIndex
CREATE INDEX "TokenHeader_symbol_idx" ON "TokenHeader"("symbol");

-- CreateIndex
CREATE INDEX "TokenHistory_tokenId_interval_timestamp_idx" ON "TokenHistory"("tokenId", "interval", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "TokenHistory_tokenId_interval_timestamp_key" ON "TokenHistory"("tokenId", "interval", "timestamp");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

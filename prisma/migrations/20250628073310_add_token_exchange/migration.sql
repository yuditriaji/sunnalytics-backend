-- AlterTable
ALTER TABLE "TokenHeader" ADD COLUMN     "avgPrice" DOUBLE PRECISION,
ADD COLUMN     "exchangeCount" INTEGER,
ADD COLUMN     "totalVolume24h" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "TokenExchange" (
    "id" SERIAL NOT NULL,
    "exchangeId" TEXT NOT NULL,
    "baseTokenId" TEXT NOT NULL,
    "tokenId" TEXT,
    "targetCurrency" TEXT NOT NULL,
    "lastPrice" DOUBLE PRECISION,
    "volume24h" DOUBLE PRECISION,
    "bidAskSpreadPercentage" DOUBLE PRECISION,
    "lastTradedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenExchange_exchangeId_idx" ON "TokenExchange"("exchangeId");

-- CreateIndex
CREATE INDEX "TokenExchange_baseTokenId_idx" ON "TokenExchange"("baseTokenId");

-- CreateIndex
CREATE INDEX "TokenExchange_tokenId_idx" ON "TokenExchange"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenExchange_exchangeId_baseTokenId_targetCurrency_key" ON "TokenExchange"("exchangeId", "baseTokenId", "targetCurrency");

-- AddForeignKey
ALTER TABLE "TokenExchange" ADD CONSTRAINT "TokenExchange_baseTokenId_fkey" FOREIGN KEY ("baseTokenId") REFERENCES "TokenHeader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenExchange" ADD CONSTRAINT "TokenExchange_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TokenExchange" (
    "id" SERIAL NOT NULL,
    "tokenId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lastPrice" DOUBLE PRECISION,
    "volume" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenExchange_symbol_idx" ON "TokenExchange"("symbol");

-- CreateIndex
CREATE INDEX "TokenExchange_exchange_idx" ON "TokenExchange"("exchange");

-- CreateIndex
CREATE UNIQUE INDEX "TokenExchange_tokenId_exchange_key" ON "TokenExchange"("tokenId", "exchange");

-- CreateIndex
CREATE INDEX "Token_symbol_idx" ON "Token"("symbol");

-- CreateIndex
CREATE INDEX "Token_exchange_idx" ON "Token"("exchange");

-- AddForeignKey
ALTER TABLE "TokenExchange" ADD CONSTRAINT "TokenExchange_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

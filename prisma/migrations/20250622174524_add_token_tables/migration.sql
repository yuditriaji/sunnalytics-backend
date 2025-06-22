-- CreateTable
CREATE TABLE "TokenHeader" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platforms" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenHeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenDetail" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "walletDistributionScore" DOUBLE PRECISION,
    "poolLiquidity" DOUBLE PRECISION,
    "txActivityScore" DOUBLE PRECISION,
    "transferVolume24h" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenDetail_pkey" PRIMARY KEY ("id")
);

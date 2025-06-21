-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "liquidityScore" DOUBLE PRECISION,
ADD COLUMN     "pumpDumpRiskScore" DOUBLE PRECISION,
ADD COLUMN     "walletDistributionScore" DOUBLE PRECISION;

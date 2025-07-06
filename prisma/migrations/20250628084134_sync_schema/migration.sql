/*
  Warnings:

  - Added the required column `symbol` to the `TokenExchange` table without a default value. This is not possible if the table is not empty.
  - Made the column `lastPrice` on table `TokenExchange` required. This step will fail if there are existing NULL values in that column.
  - Made the column `volume24h` on table `TokenExchange` required. This step will fail if there are existing NULL values in that column.
  - Made the column `lastTradedAt` on table `TokenExchange` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "TokenExchange" DROP CONSTRAINT "TokenExchange_baseTokenId_fkey";

-- DropIndex
DROP INDEX "TokenExchange_baseTokenId_idx";

-- DropIndex
DROP INDEX "TokenExchange_exchangeId_idx";

-- AlterTable
ALTER TABLE "TokenExchange" ADD COLUMN     "symbol" TEXT NOT NULL,
ALTER COLUMN "lastPrice" SET NOT NULL,
ALTER COLUMN "volume24h" SET NOT NULL,
ALTER COLUMN "lastTradedAt" SET NOT NULL;

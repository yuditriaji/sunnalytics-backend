/*
  Warnings:

  - You are about to drop the column `avgPrice` on the `TokenHeader` table. All the data in the column will be lost.
  - You are about to drop the column `exchangeCount` on the `TokenHeader` table. All the data in the column will be lost.
  - You are about to drop the column `totalVolume24h` on the `TokenHeader` table. All the data in the column will be lost.
  - You are about to drop the `TokenExchange` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "TokenExchange" DROP CONSTRAINT "TokenExchange_tokenId_fkey";

-- AlterTable
ALTER TABLE "TokenHeader" DROP COLUMN "avgPrice",
DROP COLUMN "exchangeCount",
DROP COLUMN "totalVolume24h";

-- DropTable
DROP TABLE "TokenExchange";

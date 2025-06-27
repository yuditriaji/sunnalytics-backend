-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "exchange" TEXT;

-- AlterTable
ALTER TABLE "TokenHeader" ADD COLUMN     "exchange" TEXT;

-- AddForeignKey
ALTER TABLE "TokenDetail" ADD CONSTRAINT "TokenDetail_id_fkey" FOREIGN KEY ("id") REFERENCES "TokenHeader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "agreed" BOOLEAN DEFAULT false,
ADD COLUMN     "subscribed" BOOLEAN DEFAULT false,
ALTER COLUMN "paid" DROP NOT NULL;

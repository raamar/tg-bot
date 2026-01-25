const prismaPkg = require("@prisma/client");

const prisma = new prismaPkg.PrismaClient();

module.exports = {
    prisma,
    ...prismaPkg, // Prisma, enums и прочее
};

export default {
  schema: 'prisma/schema.prisma',
  datasource: {
    url:
      process.env.DATABASE_URL || 'postgresql://jam:jampassword@localhost:5432/jamdb?schema=public',
  },
};

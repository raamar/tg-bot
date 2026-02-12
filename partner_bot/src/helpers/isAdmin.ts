export const isAdmin = (userId?: number): boolean => {
  if (!userId) return false
  const adminIds = process.env.ADMIN_IDS?.split(',').map(Number) || []
  return adminIds.includes(userId)
}

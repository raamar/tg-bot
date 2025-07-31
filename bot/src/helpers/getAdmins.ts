export const getAdmins = (): number[] => {
  return process.env.ADMIN_IDS?.split(',').map(Number) || []
}

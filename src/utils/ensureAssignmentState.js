const AssignmentState = require("../../models/Robin-hood");

async function ensureAssignmentState() {
  const count = await AssignmentState.count();
  if (count === 0) {
    await AssignmentState.create({ last_rep_id: null });
    console.log("✅ AssignmentState initialized");
  }
}

module.exports = ensureAssignmentState;

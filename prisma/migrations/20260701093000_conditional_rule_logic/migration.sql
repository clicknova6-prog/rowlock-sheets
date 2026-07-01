ALTER TABLE `RuleCondition`
  MODIFY `operator` ENUM(
    'EQUALS',
    'IN_LIST',
    'CONTAINS',
    'NOT_EQUALS',
    'NOT_IN_LIST',
    'NOT_CONTAINS',
    'EMPTY',
    'NOT_EMPTY'
  ) NOT NULL,
  ADD COLUMN `joinOperator` ENUM('AND', 'OR') NOT NULL DEFAULT 'AND' AFTER `operator`;

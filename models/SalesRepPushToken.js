module.exports = (sequelize, DataTypes) => {
    const SalesRepPushToken = sequelize.define(
      "SalesRepPushToken",
      {
        id: {
          type: DataTypes.INTEGER,
          autoIncrement: true,
          primaryKey: true,
        },
        sales_rep_id: {
          type: DataTypes.INTEGER,
          allowNull: false,
        },
        token: {
          type: DataTypes.STRING(255),
          allowNull: false,
          unique: true,
        },
        created_at: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW,
        },
        last_seen_at: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW,
        },
      },
      {
        tableName: "sales_rep_push_tokens",
        timestamps: false,
      }
    );
  
    SalesRepPushToken.associate = (models) => {
      SalesRepPushToken.belongsTo(models.SalesRep, {
        foreignKey: "sales_rep_id",
        onDelete: "CASCADE",
      });
    };
  
    return SalesRepPushToken;
  };
  
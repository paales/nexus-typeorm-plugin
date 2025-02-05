import { dynamicOutputMethod } from 'nexus'
import { SchemaBuilder } from '../schema-builder'
import { GraphQLFieldResolver } from 'graphql'
import { findEntityByTypeName, getEntityPrimaryColumn, getEntityTypeName } from '../util'
import { getConnection } from 'typeorm'
import { columnToGraphQLTypeDef } from '../type'
import { ORMResolverContext } from '../dataloader/entity-dataloader'
import { ArgWhereType } from '../args/arg-where'
import { PaginationFieldResolveFn } from './pagination-output-method'

declare global {
  export interface NexusGenCustomOutputMethods<TypeName extends string> {
    entityField(fieldName: string, config?: EntityFieldConfig): void
    entityFields(fields: string[] | '*', options?: EntityFieldsOptions): void
  }
}

export interface EntityFieldConfig {
  alias?: string
  resolve?: (
    source: any,
    args: any,
    ctx: any,
    info: any,
    next?: GraphQLFieldResolver<any, any, any>,
  ) => any
}

export function createEntityFieldOutputMethod(schemaBuilder: SchemaBuilder) {
  return dynamicOutputMethod({
    name: 'entityField',
    factory({ typeDef: t, args, builder }) {
      const [fieldName, options = {}] = args as [string, EntityFieldConfig | undefined]
      const entity = findEntityByTypeName(t.typeName, schemaBuilder.entities)

      if (!entity) {
        throw new Error(`Unable to find entity by type name '${t.typeName}'`)
      }

      const entityMetadata = getConnection().getMetadata(entity)
      const relation = entityMetadata.findRelationWithPropertyPath(fieldName)

      if (relation) {
        const relatedEntity = schemaBuilder.entities[relation.inverseEntityMetadata.name]
        const relatedEntityTypeName = getEntityTypeName(relatedEntity)

        if (!relatedEntity) {
          throw new Error(
            `Unable to find related entity '${t.typeName}' of property '${relation.propertyName}' on '${entityMetadata.name}' `,
          )
        }

        if (relation.isOneToMany || relation.isManyToMany) {
          if (!relation.inverseRelation || !relation.inverseRelation.foreignKeys[0]) {
            throw new Error(
              `Unable to access inverseRelation on '${entityMetadata.name}.${
                relation.propertyName
              }'. It's probably missing the inverse side function on @${
                relation.isOneToMany ? 'OneToMany' : 'ManyToMany'
              }()`,
            )
          }

          const inverseForeignKeyName = relation.inverseRelation.foreignKeys[0].columnNames[0]
          const resolve: PaginationFieldResolveFn = (source, args, ctx, info, next) => {
            if (!args.where && source[relation.propertyName]) {
              return source[relation.propertyName]
            }

            args.where = {
              ...args.where,
              [inverseForeignKeyName]: source[entityMetadata.primaryColumns[0].propertyName],
            }

            return next(source, args, ctx, info)
          }

          t.paginationField(options.alias || relation.propertyName, {
            entity: relatedEntityTypeName,
            resolve: options.resolve
              ? (source, args, ctx, info, next) =>
                  options.resolve!(source, args, ctx, info, () =>
                    resolve(source, args, ctx, info, next),
                  )
              : resolve,
          })
        } else {
          const sourceForeignKey = (relation.inverseRelation &&
          relation.inverseRelation.foreignKeys.length > 0
            ? relation.inverseRelation.foreignKeys[0]
            : relation.foreignKeys[0]
          ).columnNames[0]

          const entityPrimaryKey = getEntityPrimaryColumn(entity)
          const isRelationOwner = relation.isOneToOneOwner || relation.isManyToOne
          const resolve: GraphQLFieldResolver<any, any, {}> = (
            source: any,
            _,
            ctx: ORMResolverContext,
          ) => {
            if (source[relation.propertyName]) {
              return source[relation.propertyName]
            }

            if (
              isRelationOwner &&
              !Object.prototype.hasOwnProperty.call(source, sourceForeignKey)
            ) {
              if (!ctx || !ctx.ignoreErrors) {
                throw new Error(
                  `Foreign key '${sourceForeignKey}' is not defined in ${entityMetadata.name} schema`,
                )
              }

              return null
            }

            if (ctx && ctx.orm) {
              return isRelationOwner
                ? ctx.orm.entitiesDataLoader.load({
                    entity: relatedEntity,
                    value: source[sourceForeignKey],
                  })
                : ctx.orm.queryDataLoader.load({
                    entity,
                    type: 'one',
                    schemaBuilder,
                    where: {
                      [sourceForeignKey]: source[entityPrimaryKey.propertyName],
                    } as ArgWhereType,
                  })
            }

            if (!isRelationOwner) {
              return getConnection()
                .getRepository(relatedEntity)
                .findOne({ [sourceForeignKey]: source[entityPrimaryKey.propertyName] })
            }

            return getConnection()
              .getRepository(relatedEntity)
              .findOne(source[sourceForeignKey])
          }

          t.field(relation.propertyName, {
            type: relatedEntityTypeName,
            nullable: relation.isNullable,
            resolve: options.resolve
              ? (source, args, ctx, info) => options.resolve!(source, args, ctx, info, resolve)
              : resolve,
          })
        }
        return
      }

      const column = entityMetadata.findColumnWithPropertyPath(fieldName)
      if (column) {
        let type: string | undefined

        if (column.type === 'enum') {
          type = schemaBuilder.useType(builder, {
            type: 'enum',
            entity,
            column,
          })
        } else {
          type = columnToGraphQLTypeDef(column, entity)
        }

        t.field(options.alias || fieldName, {
          type,
          nullable: column.isNullable,
          resolve: options.resolve,
        })
        return
      }

      throw new Error(`Unable to find column '${fieldName}' on entity ${entity.name}`)
    },
  })
}

export interface EntityFieldsOptions {
  ignore?: string[]
}

export function createEntityFieldsOutputMethod(schemaBuilder: SchemaBuilder) {
  return dynamicOutputMethod({
    name: 'entityFields',
    factory({ typeDef: t, args }) {
      let fields: string[] = args[0] === '*' ? [] : args[0]
      const options: EntityFieldsOptions = args[1] || {}

      if (args[0] === '*') {
        const entity = findEntityByTypeName(t.typeName, schemaBuilder.entities)

        if (!entity) {
          throw new Error(`Unable to find entity by type name '${t.typeName}'`)
        }

        const entityMetadata = getConnection().getMetadata(entity)
        fields = [
          ...entityMetadata.columns.map(column => column.propertyName),
          ...entityMetadata.relations.map(relation => relation.propertyName),
        ]
      }

      fields.forEach(fieldName => {
        if (options && options.ignore && options.ignore.includes(fieldName)) {
          return
        }

        t.entityField(fieldName)
      })
    },
  })
}

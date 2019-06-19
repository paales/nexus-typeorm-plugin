import * as TypeORM from 'typeorm'
import {
  GraphQLFieldConfigMap,
  GraphQLFieldResolver,
  GraphQLList,
  GraphQLObjectType,
  GraphQLObjectTypeConfig,
  GraphQLOutputType,
  GraphQLSchema,
  GraphQLSchemaConfig,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLEnumType,
} from 'graphql'

import { getDatabaseObjectMetadata } from '.'
import { typeORMColumnTypeToGraphQLOutputType } from './type'
import { createArgs, translateWhereClause } from './where'
import { orderNamesToOrderInfos } from './order'
import { resolve } from './resolver'
import { orderItemsByPrimaryColumns } from './util'

interface BuildExecutableSchemaOptions {
  entities: any[]
  defaultLimit?: number
  maxLimit?: number
}

export interface SchemaInfo {
  whereInputTypes: {[key: string]: GraphQLInputObjectType}
  types: {[key: string]: GraphQLOutputType}
  orderByInputTypes: {[key: string]: GraphQLEnumType}
}

export function buildExecutableSchema<TSource = any, TContext = any>({
  entities,
  defaultLimit,
  maxLimit,
}: BuildExecutableSchemaOptions): GraphQLSchema {
  const conn = TypeORM.getConnection()
  const schemaInfo: SchemaInfo = {
    whereInputTypes: {},
    types: {},
    orderByInputTypes: {},
  }

  const rootQueryFields: GraphQLFieldConfigMap<TSource, TContext> = {}

  for (const entity of entities) {
    const meta = getDatabaseObjectMetadata(entity.prototype)
    const typeormMetadata = conn.getMetadata(entity)
    const { name } = typeormMetadata
    const args = createArgs(schemaInfo, entity)

    const type = new GraphQLObjectType({
      name,
      fields: () => {
        const fields: GraphQLFieldConfigMap<TSource, TContext> = {}

        meta.fields.forEach(field => {
          fields[field.propertyKey] = {
            type: GraphQLString,
          }
        })

        typeormMetadata.columns.forEach(column => {
          const graphqlType = typeORMColumnTypeToGraphQLOutputType(column.type)

          if (graphqlType) {
            fields[column.propertyName] = {
              type: graphqlType,
            }
          }
        })

        typeormMetadata.relations.forEach(relation => {
          const targetMeta = conn.getMetadata(relation.type)
          const targetGraphQLType = schemaInfo.types[targetMeta.name]
          const { relationType } = relation

          if (targetGraphQLType) {
            const type =
              relationType === 'one-to-many' ? GraphQLList(targetGraphQLType) :
                relationType === 'many-to-one' ? targetGraphQLType :
                  undefined

            if (type) {
              fields[relation.propertyName] = {
                args: createArgs(schemaInfo, relation.type),
                type,
              }
            }
          }
        })

        return fields
      }
    })

    schemaInfo.types[name] = type

    if (meta.views) {
      meta.views.forEach(view => {
        if ('isDirectView' in view) {
          rootQueryFields[view.name] = {
            args,
            type: GraphQLList(type),

            async resolve(..._args: Parameters<GraphQLFieldResolver<any, any, any>>) {
              const [, args, , info] = _args

              return resolve({
                where: args.where ? translateWhereClause(typeormMetadata.name, args.where) : undefined,
                entity,
                skip: args.skip || 0,
                take: Math.max(args.first || defaultLimit || 30, maxLimit || 100),
                orders: args.orderBy ? orderNamesToOrderInfos(args.orderBy) : undefined,
                info,
              })
            }
          }
        } else {
          rootQueryFields[view.name] = {
            args: view.args,
            type: GraphQLList(type),

            async resolve(..._args: Parameters<GraphQLFieldResolver<any, any, any>>) {
              const [, args, ctx, info] = _args
              const ids = await view.getIds({
                args,
                ctx,
              })

              const resolved = await resolve({
                entity,
                info,
                ids,
              })

              if (typeormMetadata.hasMultiplePrimaryKeys) {
                return resolved
              }
              return orderItemsByPrimaryColumns(typeormMetadata.primaryColumns, resolved, ids)
            }
          }
        }
      })
    }
  }

  const queryConfig: GraphQLObjectTypeConfig<TSource, TContext> = {
    name: 'Query',
    fields: rootQueryFields,
  }

  const query: GraphQLSchemaConfig['query'] = new GraphQLObjectType(queryConfig)

  const config: GraphQLSchemaConfig = {
    query,
  }

  return new GraphQLSchema(config)
}

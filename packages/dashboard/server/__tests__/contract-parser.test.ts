/**
 * Tests for the Contract Guard parsers — openapi/proto/graphql/json-schema.
 * Uses node:test + node:assert/strict.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOpenapi,
  parseProto,
  parseGraphql,
  parseJsonSchema,
} from '../contract-parser.js';

// ── OpenAPI ──────────────────────────────────────────────────────────────

describe('parseOpenapi', () => {
  it('extracts endpoints and component schemas from a minimal YAML spec', () => {
    const yaml = `openapi: 3.0.0
info:
  title: Users API
  version: 1.0.0
paths:
  /users:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/NewUser'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
components:
  schemas:
    User:
      type: object
      required: [id, email]
      properties:
        id:
          type: string
        email:
          type: string
        nickname:
          type: string
          nullable: true
    NewUser:
      type: object
      required: [email]
      properties:
        email:
          type: string
`;
    const c = parseOpenapi(yaml, 'api/openapi.yaml', 'repo');
    assert.ok(c);
    assert.equal(c!.kind, 'openapi');
    assert.equal(c!.name, 'Users API');
    assert.equal(c!.version, '1.0.0');
    assert.equal(c!.endpoints.length, 2);
    const get = c!.endpoints.find((e) => e.id === 'GET /users');
    assert.ok(get);
    assert.equal(get!.responseType, 'User');
    const post = c!.endpoints.find((e) => e.id === 'POST /users');
    assert.ok(post);
    assert.equal(post!.requestType, 'NewUser');
    assert.equal(post!.responseType, 'User');
    const user = c!.types['User'];
    assert.equal(user.kind, 'object');
    assert.equal(user.fields.length, 3);
    const email = user.fields.find((f) => f.name === 'email');
    assert.equal(email?.required, true);
    const nickname = user.fields.find((f) => f.name === 'nickname');
    assert.equal(nickname?.nullable, true);
  });

  it('parses a JSON OpenAPI spec (first non-whitespace char is {)', () => {
    const json = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'T', version: '0.1' },
      paths: {
        '/ping': {
          get: {
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const c = parseOpenapi(json, 'openapi.json', 'repo');
    assert.ok(c);
    assert.equal(c!.endpoints.length, 1);
    assert.equal(c!.endpoints[0].id, 'GET /ping');
  });
});

// ── Proto ────────────────────────────────────────────────────────────────

describe('parseProto', () => {
  it('extracts a service with one rpc and referenced messages', () => {
    const proto = `syntax = "proto3";
package user.v1;

// A user record.
message User {
  string id = 1;
  string email = 2;
  repeated string tags = 3;
}

message GetUserRequest { string id = 1; }

service UserService {
  // Fetch one user.
  rpc GetUser(GetUserRequest) returns (User);
}
`;
    const c = parseProto(proto, 'user/v1/user.proto', 'repo');
    assert.equal(c.kind, 'protobuf');
    assert.equal(c.name, 'user.v1');
    assert.equal(c.endpoints.length, 1);
    assert.equal(c.endpoints[0].id, 'user.v1.UserService/GetUser');
    assert.equal(c.endpoints[0].requestType, 'GetUserRequest');
    assert.equal(c.endpoints[0].responseType, 'User');
    const user = c.types['User'];
    assert.equal(user.kind, 'object');
    const tags = user.fields.find((f) => f.name === 'tags');
    assert.equal(tags?.type, 'array<string>');
  });
});

// ── GraphQL ──────────────────────────────────────────────────────────────

describe('parseGraphql', () => {
  it('extracts types and enums with required markers', () => {
    const gql = `# a comment
"""doc block"""
type User {
  id: ID!
  email: String!
  nickname: String
  role: Role!
}

enum Role {
  ADMIN
  USER
  GUEST
}

type Query {
  user(id: ID!): User
}
`;
    const c = parseGraphql(gql, 'schema.graphql', 'repo');
    const user = c.types['User'];
    assert.ok(user);
    assert.equal(user.kind, 'object');
    const email = user.fields.find((f) => f.name === 'email');
    assert.equal(email?.required, true);
    assert.equal(email?.type, 'String');
    const nickname = user.fields.find((f) => f.name === 'nickname');
    assert.equal(nickname?.required, false);
    const role = c.types['Role'];
    assert.equal(role.kind, 'enum');
    assert.deepEqual(role.enumValues, ['ADMIN', 'USER', 'GUEST']);
    const q = c.endpoints.find((e) => e.id === 'Query.user');
    assert.ok(q);
    assert.equal(q!.responseType, 'User');
  });
});

// ── JSON Schema ──────────────────────────────────────────────────────────

describe('parseJsonSchema', () => {
  it('reads required array, properties, and enum values', () => {
    const schema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'Order',
      type: 'object',
      required: ['id', 'status'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'closed'] },
        note: { type: ['string', 'null'] },
      },
    });
    const c = parseJsonSchema(schema, 'order.schema.json', 'repo');
    assert.ok(c);
    const t = c!.types['Order'];
    assert.equal(t.kind, 'object');
    const id = t.fields.find((f) => f.name === 'id');
    assert.equal(id?.required, true);
    const status = t.fields.find((f) => f.name === 'status');
    assert.deepEqual(status?.enumValues, ['open', 'closed']);
    const note = t.fields.find((f) => f.name === 'note');
    assert.equal(note?.nullable, true);
    assert.equal(note?.required, false);
  });
});

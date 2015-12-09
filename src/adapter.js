import _ from 'underscore';
import buildUriTemplate from './uri-template';
import SwaggerParser from 'swagger-parser';
import yaml from 'js-yaml';
import yamlAst from 'yaml-js';

// These describe the type of annotations that are produced by this parser
// and assigns a unique code to each one. Downstream applications can use this
// code to group similar types of annotations together.
const ANNOTATIONS = {
  CANNOT_PARSE: {
    type: 'error',
    code: 1,
    fragment: 'yaml-parser',
  },
  AST_UNAVAILABLE: {
    type: 'warning',
    code: 2,
    fragment: 'yaml-parser',
  },
  DATA_LOST: {
    type: 'warning',
    code: 3,
    fragment: 'refract-not-supported',
  },
  VALIDATION_ERROR: {
    type: 'warning',
    code: 4,
    fragment: 'swagger-validation',
  },
};

export const name = 'swagger';

// TODO: Figure out media type for Swagger 2.0
export const mediaTypes = [
  'application/swagger+json',
  'application/swagger+yaml',
];

export function detect(source) {
  return !!(_.isString(source)
    ? source.match(/"?swagger"?:\s*["']2\.0["']/g)
    : source.swagger === '2.0');
}

// Test whether a key is a special Swagger extension.
function isExtension(value, key) {
  return key.indexOf('x-') === 0;
}

// Test whether tags can be treated as resource groups, and if so it sets a
// group name for each resource (used later to create groups).
function useResourceGroups(api) {
  const tags = [];

  if (api.paths) {
    _.each(api.paths, (path) => {
      let tag = null;

      if (path) {
        _.each(path, (operation) => {
          if (operation.tags && operation.tags.length) {
            if (operation.tags.length > 1) {
              // Too many tags... each resource can only be in one group!
              return false;
            }

            if (tag === null) {
              tag = operation.tags[0];
            } else if (tag !== operation.tags[0]) {
              // Non-matching tags... can't have a resource in multiple groups!
              return false;
            }
          }
        });
      }

      if (tag) {
        path['x-group-name'] = tag;
        tags.push(tag);
      }
    });
  }

  return tags.length > 0;
}

// Look up a position in the original source based on a JSON path, for
// example 'paths./test.get.responses.200'
function getPosition(ast, path) {
  const pieces = _.isArray(path) ? path.splice(0) : path.split('.');
  let end;
  let node = ast;
  let piece = pieces.shift();
  let start;

  while (piece) {
    let newNode = null;
    let index = null;

    // If a piece ends with an array index, then we need to make sure we fetch
    // that specific item from the value array.
    const match = piece.match(/(.*)\[([0-9])+\]$/);
    if (match) {
      piece = match[1];
      index = parseInt(match[2], 10);
    }

    for (const subNode of node.value) {
      if (subNode[0] && subNode[0].value === piece) {
        if (pieces.length) {
          newNode = subNode[1];
          if (index !== null) {
            newNode = newNode.value[index];
          }
        } else {
          // This is the last item!
          if (index !== null) {
            newNode = subNode[1].value[index];
            start = newNode.start_mark.pointer;
            end = newNode.end_mark.pointer;
          } else {
            newNode = subNode[0];
            start = subNode[0].start_mark.pointer;
            end = subNode[1].end_mark.pointer;
          }
        }
        break;
      } else if (subNode[0] && subNode[0].value === '$ref') {
        if (subNode[1].value.indexOf('#') === 0) {
          // This is an internal reference! First, we reset the node to the
          // root of the document, shift the ref item off the pieces stack
          // and then add the referenced path to the pieces.
          const refPaths = subNode[1].value.substr(2).split('/');
          newNode = ast;
          Array.prototype.unshift.apply(pieces, refPaths.concat([piece]));
          break;
        } else {
          console.log(`External reference ${subNode[1].value} not supported for source maps!`);
        }
      }
    }

    if (newNode) {
      node = newNode;
    } else {
      return null;
    }

    piece = pieces.shift();
  }

  return {start, end};
}

// Make a new source map for the given element
function makeSourceMap(SourceMap, ast, element, path) {
  const position = getPosition(ast, path);
  if (position) {
    element.attributes.set('sourceMap', [
      new SourceMap([[position.start, position.end - position.start]]),
    ]);
  }
}

// Make a new annotation for the given path and message
function makeAnnotation(Annotation, Link, SourceMap, ast, result, info, path, message) {
  const annotation = new Annotation(message);
  annotation.classes.push(info.type);
  annotation.code = info.code;
  result.content.push(annotation);

  if (info.fragment) {
    const link = new Link();
    link.relation = 'origin';
    link.href = `http://docs.apiary.io/validations/swagger#${info.fragment}`;
    annotation.links.push(link);
  }

  if (ast && path) {
    const position = getPosition(ast, path);
    if (position && !isNaN(position.start) && !isNaN(position.end)) {
      annotation.attributes.set('sourceMap', [
        new SourceMap([[position.start, position.end - position.start]]),
      ]);
    }
  }
}

function convertParameterToElement(minim, parameter) {
  const StringElement = minim.getElementClass('string');
  const NumberElement = minim.getElementClass('number');
  const BooleanElement = minim.getElementClass('boolean');
  const ArrayElement = minim.getElementClass('array');
  const MemberElement = minim.getElementClass('member');

  let memberValue;

  // Convert from Swagger types to Minim elements
  if (parameter.type === 'string') {
    memberValue = new StringElement('');
  } else if (parameter.type === 'integer' || parameter.type === 'number') {
    memberValue = new NumberElement();
  } else if (parameter.type === 'boolean') {
    memberValue = new BooleanElement();
  } else if (parameter.type === 'array') {
    memberValue = new ArrayElement();
  } else {
    // Default to a string in case we get a type we haven't seen
    memberValue = new StringElement('');
  }

  // TODO: Update when Minim has better support for elements as values
  // should be: new MemberType(parameter.name, memberValue);
  const member = new MemberElement(parameter.name);
  member.content.value = memberValue;

  if (parameter.description) {
    member.description = parameter.description;
  }

  if (parameter.required) {
    member.attributes.set('typeAttributes', ['required']);
  }

  // If there is a default, it is set on the member value instead of the member
  // element itself because the default value applies to the value.
  if (parameter.default) {
    memberValue.attributes.set('default', parameter.default);
  }

  return member;
}

function createAssetFromJsonSchema(minim, jsonSchema) {
  const Asset = minim.getElementClass('asset');
  const schemaAsset = new Asset(JSON.stringify(jsonSchema));
  schemaAsset.classes.push('messageBodySchema');
  schemaAsset.attributes.set('contentType', 'application/schema+json');

  return schemaAsset;
}

function createTransaction(minim, transition, method) {
  const HttpTransaction = minim.getElementClass('httpTransaction');
  const HttpRequest = minim.getElementClass('httpRequest');
  const HttpResponse = minim.getElementClass('httpResponse');
  const transaction = new HttpTransaction();
  transaction.content = [new HttpRequest(), new HttpResponse()];

  if (transition) {
    transition.content.push(transaction);
  }

  if (method) {
    transaction.request.attributes.set('method', method.toUpperCase());
  }

  return transaction;
}

/*
 * Parse Swagger 2.0 into Refract elements
 */
export function parse({minim, source, generateSourceMap}, done) {
  // TODO: Will refactor this once API Description namespace is stable
  // Leaving as large block of code until then
  const Annotation = minim.getElementClass('annotation');
  const Asset = minim.getElementClass('asset');
  const Copy = minim.getElementClass('copy');
  const Category = minim.getElementClass('category');
  const HrefVariables = minim.getElementClass('hrefVariables');
  const HttpHeaders = minim.getElementClass('httpHeaders');
  const Link = minim.getElementClass('link');
  const MemberElement = minim.getElementClass('member');
  const ParseResult = minim.getElementClass('parseResult');
  const Resource = minim.getElementClass('resource');
  const SourceMap = minim.getElementClass('sourceMap');
  const Transition = minim.getElementClass('transition');

  const paramToElement = convertParameterToElement.bind(
    convertParameterToElement, minim);

  const parser = new SwaggerParser();
  const parseResult = new ParseResult();

  let loaded;
  try {
    loaded = _.isString(source) ? yaml.safeLoad(source) : source;
  } catch (err) {
    makeAnnotation(Annotation, Link, SourceMap, null, parseResult,
      ANNOTATIONS.CANNOT_PARSE, null, 'Problem loading the input');
    return done(null, parseResult);
  }

  let ast = null;
  if (_.isString(source)) {
    // TODO: Could we lazy-load the AST here? Seems like a waste of time if
    //       we load it but don't wind up using it.
    try {
      ast = yamlAst.compose(source);
    } catch (err) {
      makeAnnotation(Annotation, Link, SourceMap, null, parseResult,
        ANNOTATIONS.AST_UNAVAILABLE, null,
        'Input AST could not be composed, so source maps will not be available');
    }
  } else {
    makeAnnotation(Annotation, Link, SourceMap, null, parseResult,
      ANNOTATIONS.AST_UNAVAILABLE, null,
      'Source maps are only available with string input');
  }

  // Some sane defaults since these are sometimes left out completely
  if (loaded.info === undefined) {
    loaded.info = {};
  }

  if (loaded.paths === undefined) {
    loaded.paths = {};
  }

  // Parse and validate the Swagger document!
  parser.validate(loaded, (err) => {
    const swagger = parser.api;

    if (err) {
      if (swagger === undefined) {
        return done(err, parseResult);
      }

      // Non-fatal errors, so let us try and create annotations for them and
      // continue with the parsing as best we can.
      if (err.details) {
        const queue = [err.details];
        while (queue.length) {
          for (const item of queue[0]) {
            makeAnnotation(Annotation, Link, SourceMap, ast, parseResult,
              ANNOTATIONS.VALIDATION_ERROR, item.path, item.message);

            if (item.inner) {
              // TODO: I am honestly not sure what the correct behavior is
              // here. Some items will have within them a tree of other items,
              // some of which might contain more info (but it's unclear).
              // Do we treat them as their own error or do something else?
              queue.push(item.inner);
            }
          }
          queue.shift();
        }
      }
    }

    const basePath = (swagger.basePath || '').replace(/[/]+$/, '');
    const setupSourceMap = makeSourceMap.bind(makeSourceMap, SourceMap, ast);
    const setupAnnotation = makeAnnotation.bind(makeAnnotation, Annotation,
      Link, SourceMap, ast, parseResult);

    const api = new Category();
    parseResult.push(api);

    // Root API Element
    api.classes.push('api');

    if (swagger.info) {
      if (swagger.info.title) {
        api.meta.set('title', swagger.info.title);

        if (generateSourceMap && ast) {
          setupSourceMap(api.meta.get('title'), 'info.title');
        }
      }

      if (swagger.info.description) {
        api.content.push(new Copy(swagger.info.description));

        if (generateSourceMap && ast) {
          setupSourceMap(api.content[api.content.length - 1], 'info.description');
        }
      }
    }

    if (swagger.host) {
      let hostname = swagger.host;

      if (swagger.schemes) {
        if (swagger.schemes.length > 1) {
          setupAnnotation(ANNOTATIONS.DATA_LOST, 'schemes',
            'Only the first scheme will be used to create a hostname');
        }

        hostname = `${swagger.schemes[0]}://${hostname}`;
      }

      api.attributes.set('meta', {});
      const meta = api.attributes.get('meta');
      const member = new MemberElement('HOST', hostname);
      member.meta.set('classes', ['user']);

      if (generateSourceMap && ast) {
        setupSourceMap(member, 'host');
      }

      meta.content.push(member);
    }

    if (swagger.securityDefinitions) {
      setupAnnotation(ANNOTATIONS.DATA_LOST, 'securityDefinitions',
        'Authentication information is not yet supported');
    }

    if (swagger.security) {
      setupAnnotation(ANNOTATIONS.DATA_LOST, 'security',
        'Authentication information is not yet supported');
    }

    if (swagger.externalDocs) {
      setupAnnotation(ANNOTATIONS.DATA_LOST, 'externalDocs',
        'External documentation is not yet supported');
    }

    const useGroups = useResourceGroups(swagger);
    let group = api;

    // Swagger has a paths object to loop through
    // The key is the href
    _.each(_.omit(swagger.paths, isExtension), (pathValue, href) => {
      const resource = new Resource();

      if (generateSourceMap && ast) {
        setupSourceMap(resource, `paths.${href}`);
      }

      // Provide users with a way to add a title to a resource in Swagger
      if (pathValue['x-summary']) {
        resource.title = pathValue['x-summary'];
      }

      // Provide users a way to add a description to a resource in Swagger
      if (pathValue['x-description']) {
        const resourceDescription = new Copy(pathValue['x-description']);
        resource.push(resourceDescription);
      }

      if (useGroups) {
        const groupName = pathValue['x-group-name'];

        if (groupName) {
          group = api.find((el) => el.element === 'category' && el.classes.contains('resourceGroup') && el.title === groupName).first();

          if (!group) {
            group = new Category();
            group.title = groupName;
            group.classes.push('resourceGroup');

            if (swagger.tags && swagger.tags.forEach) {
              swagger.tags.forEach((tag) => {
                // TODO: Check for external docs here?
                if (tag.name === groupName && tag.description) {
                  group.content.push(new Copy(tag.description));
                }
              });
            }

            api.content.push(group);
          }
        }
      }

      group.content.push(resource);

      const pathObjectParameters = pathValue.parameters || [];

      // TODO: Currently this only supports URI parameters for `path` and `query`.
      // It should add support for `body` parameters as well.
      if (pathObjectParameters.length > 0) {
        resource.hrefVariables = new HrefVariables();

        pathObjectParameters.forEach((parameter, index) => {
          if (parameter.in === 'query' || parameter.in === 'path') {
            const member = paramToElement(parameter);
            if (generateSourceMap && ast) {
              setupSourceMap(member, `paths.${href}.parameters[${index}]`);
            }
            resource.hrefVariables.content.push(member);
          } else if (parameter.in === 'body') {
            setupAnnotation(ANNOTATIONS.DATA_LOST,
              `paths.${href}.parameters[${index}]`,
              'Path-level body parameters are not yet supported');
          }
        });
      }

      // TODO: Handle parameters on a resource level
      // See https://github.com/swagger-api/swagger-spec/blob/master/versions/2.0.md#path-item-object
      const relevantPaths = _.chain(pathValue)
        .omit('parameters', '$ref')
        .omit(isExtension)
        .value();

      // Each path is an object with methods as properties
      _.each(relevantPaths, (methodValue, method) => {
        const transition = new Transition();
        resource.content.push(transition);

        if (generateSourceMap && ast) {
          setupSourceMap(transition, `paths.${href}.${method}`);
        }

        if (methodValue.externalDocs) {
          setupAnnotation(ANNOTATIONS.DATA_LOST,
            `paths.${href}.${method}.externalDocs`,
            'External documentation is not yet supported');
        }

        const methodValueParameters = methodValue.parameters || [];

        const queryParameters = methodValueParameters.filter((parameter) => {
          return parameter.in === 'query';
        });

        // URI parameters are for query and path variables
        const uriParameters = methodValueParameters.filter((parameter) => {
          return parameter.in === 'query' || parameter.in === 'path';
        });

        // Body parameters are ones that define JSON Schema
        const bodyParameters = methodValueParameters.filter((parameter) => {
          return parameter.in === 'body';
        });

        // Form parameters are send as encoded form data in the body
        const formParameters = methodValueParameters.filter((parameter) => {
          return parameter.in === 'formData';
        });

        if (formParameters.length) {
          setupAnnotation(ANNOTATIONS.DATA_LOST,
            `paths.${href}.${method}.parameters`,
            'Form data parameters are not yet supported');
        }

        const hrefForResource = buildUriTemplate(basePath, href, pathObjectParameters, queryParameters);
        resource.attributes.set('href', hrefForResource);

        if (methodValue.summary) {
          transition.meta.set('title', methodValue.summary);

          if (generateSourceMap && ast) {
            const title = transition.meta.get('title');
            setupSourceMap(title, `paths.${href}.${method}.summary`);
          }
        }

        if (methodValue.description) {
          const description = new Copy(methodValue.description);
          transition.push(description);

          if (generateSourceMap && ast) {
            setupSourceMap(description, `paths.${href}.${method}.description`);
          }
        }

        if (methodValue.operationId) {
          transition.attributes.set('relation', methodValue.operationId);
        }

        // For each uriParameter, create an hrefVariable
        if (uriParameters.length > 0) {
          transition.hrefVariables = new HrefVariables();

          uriParameters.forEach((parameter) => {
            const member = paramToElement(parameter);
            if (generateSourceMap && ast) {
              const index = methodValueParameters.indexOf(parameter);
              setupSourceMap(member, `paths.${href}.${method}.parameters[${index}]`);
            }
            transition.hrefVariables.content.push(member);
          });
        }

        // Currently, default responses are not supported in API Description format
        const relevantResponses = _.chain(methodValue.responses)
          .omit('default')
          .omit(isExtension)
          .value();

        if (methodValue.responses && methodValue.responses.default) {
          setupAnnotation(ANNOTATIONS.DATA_LOST,
            `paths.${href}.${method}.responses.default`,
            'Default response is not yet supported');
        }

        if (_.keys(relevantResponses).length === 0) {
          if (bodyParameters.length) {
            // Create an empty successful response so that the request/response
            // pair gets properly generated. In the future we may want to
            // refactor the code below as this is a little weird.
            relevantResponses.null = {};
          } else {
            createTransaction(minim, transition, method);
          }
        }

        // Transactions are created for each response in the document
        _.each(relevantResponses, (responseValue, statusCode) => {
          let examples = {
            '': undefined,
          };

          if (responseValue.examples) {
            examples = responseValue.examples;
          }

          examples = _.omit(examples, 'schema');

          _.each(examples, (responseBody, contentType) => {
            const transaction = createTransaction(minim, transition, method);
            const request = transaction.request;
            const response = transaction.response;

            if (generateSourceMap && ast) {
              setupSourceMap(transaction,
                `paths.${href}.${method}.responses.${statusCode}`);
              setupSourceMap(request, `paths.${href}.${method}`);

              if (statusCode) {
                setupSourceMap(response, `paths.${href}.${method}.responses.${statusCode}`);
              }
            }

            if (responseValue.description) {
              const description = new Copy(responseValue.description);
              response.content.push(description);
              if (generateSourceMap && ast) {
                setupSourceMap(description, `paths.${href}.${method}.responses.${statusCode}.description`);
              }
            }

            const headers = new HttpHeaders();

            if (contentType) {
              headers.push(new MemberElement(
                'Content-Type', contentType
              ));

              if (generateSourceMap && ast) {
                setupSourceMap(headers.content[headers.content.length - 1], `paths.${href}.${method}.responses.${statusCode}.examples.${contentType}`);
              }

              response.headers = headers;
            }

            if (responseValue.headers) {
              for (const headerName in responseValue.headers) {
                if (responseValue.headers.hasOwnProperty(headerName)) {
                  const header = responseValue.headers[headerName];
                  let value = '';

                  // Choose the first available option
                  if (header.enum) {
                    value = header.enum[0];
                  }

                  if (header.default) {
                    value = header.default;
                  }

                  const member = new MemberElement(headerName, value);

                  if (generateSourceMap && ast) {
                    setupSourceMap(member, `paths.${href}.${method}.responses.${statusCode}.headers.${headerName}`);
                  }

                  if (header.description) {
                    member.meta.set('description', header.description);

                    if (generateSourceMap && ast) {
                      setupSourceMap(member.meta.get('description'), `paths.${href}.${method}.responses.${statusCode}.headers.${headerName}.description`);
                    }
                  }

                  headers.push(member);
                }
              }

              response.headers = headers;
            }

            // Body parameters define request schemas
            _.each(bodyParameters, (bodyParameter) => {
              const schemaAsset = createAssetFromJsonSchema(minim, bodyParameter.schema);
              request.content.push(schemaAsset);
            });

            // Responses can have bodies
            if (responseBody !== undefined) {
              let formattedResponseBody = responseBody;

              if (typeof(responseBody) === 'object') {
                formattedResponseBody = JSON.stringify(responseBody, null, 2);
              }

              const bodyAsset = new Asset(formattedResponseBody);
              bodyAsset.classes.push('messageBody');
              if (generateSourceMap && ast) {
                setupSourceMap(bodyAsset, `paths.${href}.${method}.responses.${statusCode}.examples.${contentType}`);
              }
              response.content.push(bodyAsset);
            }

            // Responses can have schemas in Swagger
            const schema = responseValue.schema || (responseValue.examples && responseValue.examples.schema);
            if (schema) {
              const schemaAsset = createAssetFromJsonSchema(minim, schema);
              response.content.push(schemaAsset);
            }

            // TODO: Decide what to do with request hrefs
            // If the URI is templated, we don't want to add it to the request
            // if (uriParameters.length === 0) {
            //   request.attributes.href = href;
            // }

            if (statusCode !== 'null') {
              response.attributes.set('statusCode', statusCode);
            }
          });
        });
      });
    });

    done(null, parseResult);
  });
}

export default {name, mediaTypes, detect, parse};

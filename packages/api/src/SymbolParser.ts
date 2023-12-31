import * as ts from 'typescript';
import deepmerge from 'deepmerge';
import { mergeJSDoc } from './jsdoc/mergeJSDoc';
import {
  PropType,
  PropKind,
  BooleanProp,
  isNumberProp,
  isAnyProp,
  isUnknownProp,
  isObjectLikeProp,
  isIndexProp,
  TypeProp,
  JSDocInfoType,
  UnionProp,
  ArrayProp,
  hasGenerics,
  isArrayProp,
  EnumProp,
  TupleProp,
  ObjectProp,
  isFunctionBaseType,
  isClassLikeProp,
  propValue,
  ClassProp,
} from './types';
import {
  getSymbolType,
  ParseOptions,
  defaultParseOptions,
  isObjectTypeDeclaration,
  isHasType,
  tsKindToPropKind,
  isGenericsType,
  isTypeParameterType,
  FunctionLike,
  isFunctionLike,
  isArrayLike,
  resolveType,
  ISymbolParser,
  getInitializer,
  updatePropKind,
  updateModifiers,
} from './ts-utils';
import {
  cleanJSDocText,
  getDeclarationName,
  parseJSDocTag,
  tagCommentToString,
} from './jsdoc/parseJSDocTags';

const strToValue = (s: string): any => {
  switch (s) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'false':
      return false;
    case 'true':
      return true;
  }
  return s;
};

export class SymbolParser implements ISymbolParser {
  private checker: ts.TypeChecker;
  private options: Required<ParseOptions>;
  private refSymbols: { props: PropType[]; symbol: ts.Symbol }[] = [];
  private propParents: Record<string, PropType> = {};
  constructor(checker: ts.TypeChecker, options?: ParseOptions) {
    this.checker = checker;
    this.options = (options?.plugins || []).reduce(
      (acc, o) => deepmerge(acc, o),
      {
        ...defaultParseOptions,
        ...options,
      },
    ) as Required<ParseOptions>;
  }
  private addRefSymbol(prop: PropType, symbol: ts.Symbol): PropType {
    const refSymbol = this.refSymbols.find((r) => r.symbol === symbol);
    if (!refSymbol) {
      this.refSymbols.push({ props: [prop], symbol });
    } else {
      refSymbol.props.push(prop);
    }
    return prop;
  }
  private getParent(
    parentProp: PropType,
    node?: ts.Node,
    parentName?: string,
  ): PropType | false | undefined {
    if (!node) {
      return false;
    }
    const addParentRef = (parent: PropType, symbol: ts.Symbol) => {
      if (this.options.saveParentProps) {
        const name = parent.displayName;
        if (name) {
          if (!this.propParents[name]) {
            this.propParents[name] = parent;
          }
        }
        return this.addRefSymbol(parent, symbol);
      }
      return parent;
    };
    let parent = node.parent;
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.expression.getText();
      if (!this.skipProperty(name)) {
        if (name === parentName || name === parentProp.parent) {
          return false;
        }
        const symbol = this.checker.getSymbolAtLocation(node.expression);
        if (symbol) {
          return addParentRef({ displayName: name }, symbol);
        }
      }
      return undefined;
    }
    while (parent) {
      if (isTypeParameterType(parent) || ts.isEnumDeclaration(parent)) {
        const name = parent.name ? parent.name.getText() : undefined;
        if (!name || !this.skipProperty(name)) {
          if (name === parentName || name === parentProp.parent) {
            return false;
          }
          const propParent = { displayName: name };
          if (parent.name) {
            const symbol = this.checker.getSymbolAtLocation(parent.name);
            if (symbol) {
              return addParentRef(propParent, symbol);
            }
          }
          return this.parseTypeValueComments(propParent, parent) || undefined;
        }
        return undefined;
      }
      parent = parent.parent;
    }
    return false;
  }

  private parseProperties(
    properties: ts.NodeArray<
      | ts.ClassElement
      | ts.ObjectLiteralElementLike
      | ts.TypeElement
      | ts.TypeNode
      | ts.HeritageClause
      | ts.EnumMember
      | ts.ArrayBindingElement
      | ts.ParameterDeclaration
      | ts.TypeParameterDeclaration
    >,
    types: PropType[] = [],
  ): PropType[] {
    const results: PropType[] = [...types];
    const addProp = (prop: PropType) => {
      const existingIdx = results.findIndex(
        (p) =>
          p.displayName &&
          p.displayName === prop.displayName &&
          p.kind === prop.kind &&
          p.type === prop.type,
      );
      if (existingIdx >= 0) {
        results[existingIdx] = { ...results[existingIdx], ...prop };
      } else {
        results.push(prop);
      }
    };
    for (const p of properties) {
      if (
        !ts.isTypeNode(p) &&
        !ts.isOmittedExpression(p) &&
        !ts.isHeritageClause(p) &&
        p.name
      ) {
        const name = p.name.getText();
        //locate property overrides.
        //when multiple properties with the same name, symbol returns the same symbol for all of them.
        // thus can not get their properties and comments
        const numProps = properties.filter(
          (f) => (f as ts.TypeElement).name?.getText() === name,
        );
        if (numProps.length <= 1) {
          const symbol = this.checker.getSymbolAtLocation(p.name);
          if (symbol) {
            const prop = this.parseSymbolProp({}, symbol);
            if (prop) {
              addProp(prop);
            }
            continue;
          }
        }
      }
      const prop = this.parseTypeValueComments({}, p, p);
      if (prop) {
        addProp(prop);
      }
    }
    return results;
  }
  private parseFunction(prop: PropType, node: FunctionLike): PropType {
    prop.kind = tsKindToPropKind[node.kind];
    if (isFunctionBaseType(prop)) {
      if (node.parameters.length && !prop.parameters) {
        prop.parameters = this.parseProperties(node.parameters);
      }
      if (node.type && !prop.returns) {
        const returns = this.parseTypeValueComments({}, node.type);
        if (returns) {
          prop.returns = returns;
        }
      }
      if (node.typeParameters?.length && !prop.types) {
        prop.types = this.parseProperties(node.typeParameters);
      }
    }
    return prop;
  }

  private parseValue(prop: PropType, node?: ts.Node): PropType {
    if (node) {
      if (isFunctionLike(node)) {
        return this.parseFunction(prop, node);
      } else if (ts.isObjectBindingPattern(node) && 'properties' in prop) {
        node.elements.forEach((e) => {
          const p = (prop as ClassProp).properties?.find(
            (p) => p.displayName === e.name.getText(),
          );
          if (p) {
            this.parseValue(p, e.initializer);
          }
        });
      } else if (ts.isObjectLiteralExpression(node) && 'properties' in prop) {
        node.properties.forEach((e) => {
          const p = (prop as ClassProp).properties?.find(
            (p) => p.displayName === e.name?.getText(),
          );
          if (p && ts.isPropertyAssignment(e)) {
            this.parseValue(p, e.initializer);
          }
        });
      } else if (
        ts.isArrayBindingPattern(node) ||
        ts.isArrayLiteralExpression(node)
      ) {
        prop.kind = PropKind.Array;
        if (isArrayProp(prop)) {
          prop.value = this.parseProperties(
            node.elements as ts.NodeArray<ts.ArrayBindingElement>,
          );
        }
      } else if (ts.isNewExpression(node)) {
        prop.kind = PropKind.Object;
        if (node.arguments) {
          (prop as ObjectProp).properties = this.parseProperties(
            node.arguments as ts.NodeArray<ts.ArrayBindingElement>,
          );
        }
      } else if (ts.isNumericLiteral(node)) {
        if (!prop.kind) {
          prop.kind = PropKind.Number;
        }
        propValue(prop, node.text);
      } else if (ts.isStringLiteral(node)) {
        if (!prop.kind) {
          prop.kind = PropKind.String;
        }
        propValue(prop, node.text);
      } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
        if (!prop.kind) {
          prop.kind = PropKind.Boolean;
        }
        (prop as BooleanProp).value = false;
      } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
        if (!prop.kind) {
          prop.kind = PropKind.Boolean;
        }
        (prop as BooleanProp).value = true;
      } else if (node.kind === ts.SyntaxKind.BooleanKeyword) {
        if (!prop.kind) {
          prop.kind = PropKind.Boolean;
        }
        propValue(prop, (node as ts.LiteralLikeNode).text);
      } else if (isAnyProp(prop)) {
        if (typeof (node as ts.LiteralLikeNode)?.text !== 'undefined') {
          prop.kind = PropKind.Undefined;
          prop.value = (node as ts.LiteralLikeNode).text;
        }
      } else if (isUnknownProp(prop)) {
        prop.kind = PropKind.Unknown;
        if (typeof (node as ts.LiteralLikeNode)?.text !== 'undefined') {
          prop.value = strToValue((node as ts.LiteralLikeNode)?.text);
        }
      } else if (isObjectLikeProp(prop)) {
        if (ts.isObjectLiteralExpression(node)) {
          prop.properties = this.parseProperties(
            node.properties,
            prop.properties,
          );
        }
      } else if (ts.isPrefixUnaryExpression(node)) {
        this.parseValue(prop, node.operand);
        if (
          node.operator === ts.SyntaxKind.MinusToken &&
          isNumberProp(prop) &&
          typeof prop.value !== 'undefined'
        ) {
          prop.value = -prop.value;
        }
      }
    }
    return prop;
  }

  public parseType(prop: PropType, node?: ts.Node): PropType {
    if (node) {
      if (isFunctionLike(node)) {
        return this.parseFunction(prop, node);
      } else if (isArrayLike(node)) {
        prop.kind = PropKind.Array;

        if (ts.isArrayTypeNode(node)) {
          const element = this.parseType({}, node.elementType);
          (prop as ArrayProp).properties = [element];
        } else if (ts.isTypeReferenceNode(node) && node.typeArguments?.length) {
          (prop as ArrayProp).properties = this.parseProperties(
            node.typeArguments,
          );
        }
      } else if (ts.isIndexSignatureDeclaration(node)) {
        prop.kind = PropKind.Index;
        if (isIndexProp(prop) && node.parameters.length) {
          const index = node.parameters[0];
          const indexProp = this.parseTypeValueComments(
            {
              displayName: index.name.getText(),
            },
            index,
          );
          if (indexProp) {
            prop.index = indexProp;
          }
        }
        const type = this.parseTypeValueComments({}, node.type);
        if (type) {
          prop.type = type;
        }
      } else if (isHasType(node) && node.type) {
        if (node.type?.kind && tsKindToPropKind[node.type.kind]) {
          prop.kind = tsKindToPropKind[node.type.kind];
        }
        if (hasGenerics(prop) && isGenericsType(node) && node.typeParameters) {
          prop.generics = this.parseProperties(node.typeParameters);
        }
        this.parseTypeValueComments(prop, node.type);
      } else if (ts.isExportAssignment(node)) {
        const symbol = this.checker.getSymbolAtLocation(node.expression);
        if (symbol) {
          return this.addRefSymbol(prop, symbol);
        }
      } else if (ts.isExportSpecifier(node)) {
        if (node.propertyName) {
          prop.displayName = node.propertyName.getText();
          const symbol = this.checker.getSymbolAtLocation(node.propertyName);
          if (symbol) {
            return this.addRefSymbol(prop, symbol);
          }
        }
      } else if (isObjectTypeDeclaration(node)) {
        if (!prop.kind) {
          prop.kind = tsKindToPropKind[node.kind];
        }

        if (isObjectLikeProp(prop)) {
          if (
            hasGenerics(prop) &&
            isGenericsType(node) &&
            !ts.isTypeLiteralNode(node) &&
            node.typeParameters
          ) {
            prop.generics = this.parseProperties(node.typeParameters);
          }

          const properties: PropType[] = this.parseProperties(node.members);
          if (
            (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) &&
            node.heritageClauses?.length
          ) {
            let extendsProp: string[] | undefined = undefined;
            if (isClassLikeProp(prop)) {
              extendsProp = [];
            }
            node.heritageClauses.forEach((h) => {
              h.types.forEach((t) => {
                if (extendsProp) {
                  extendsProp.push(t.expression.getText());
                }
              });
            });
            if (isClassLikeProp(prop)) {
              prop.extends = extendsProp;
            }
          }
          prop.properties = properties;
        }
      } else if (ts.isTypeReferenceNode(node)) {
        const symbol = this.checker.getSymbolAtLocation(node.typeName);
        if (
          symbol &&
          symbol.escapedName &&
          !this.skipProperty(symbol.escapedName.toString())
        ) {
          if (prop.parent) {
          }
          this.addRefSymbol(prop, symbol);
        } else {
          prop.type = node.getText();
        }
        if (node.typeArguments?.length && hasGenerics(prop)) {
          prop.generics = this.parseProperties(node.typeArguments);
        }
        prop.kind = PropKind.Type;
      } else if (ts.isIntersectionTypeNode(node)) {
        prop.kind = PropKind.Type;
        const properties: PropType[] = [];
        node.types.forEach((t) => {
          if (ts.isTypeLiteralNode(t)) {
            const childProp: PropType = {};

            if (tsKindToPropKind[t.kind]) {
              childProp.kind = tsKindToPropKind[t.kind];
            }

            this.parseTypeValueComments(childProp, t);
            if (isClassLikeProp(childProp) && childProp.properties) {
              properties.push(...childProp.properties);
            }
          }
        });
        (prop as TypeProp).properties = properties;
      } else if (ts.isLiteralTypeNode(node)) {
        this.parseTypeValueComments(prop, node.literal);
      } else if (ts.isParenthesizedTypeNode(node)) {
        this.parseTypeValueComments(prop, node.type);
      } else if (ts.isTypeLiteralNode(node)) {
        prop.kind = PropKind.Type;
        if (node.members.length) {
          (prop as TypeProp).properties = this.parseProperties(node.members);
        }
      } else if (ts.isOptionalTypeNode(node)) {
        prop.optional = true;
        this.parseTypeValueComments(prop, node.type);
      } else if (ts.isRestTypeNode(node)) {
        prop.kind = PropKind.Rest;
        const type = this.parseTypeValueComments({}, node.type);
        if (type) {
          prop.type = type;
        }
      } else if (ts.isUnionTypeNode(node)) {
        prop.kind = PropKind.Union;
        (prop as UnionProp).properties = this.parseProperties(node.types);
      } else if (ts.isEnumDeclaration(node)) {
        prop.kind = PropKind.Enum;
        (prop as EnumProp).properties = this.parseProperties(node.members);
      } else if (ts.isEnumMember(node)) {
        const parent = this.getParent(prop, node, prop.parent);
        if (parent) {
          prop.parent = parent.displayName;
        }
      } else if (ts.isTupleTypeNode(node)) {
        prop.kind = PropKind.Tuple;
        (prop as TupleProp).properties = this.parseProperties(node.elements);
      } else {
        switch (node.kind) {
          case ts.SyntaxKind.NumberKeyword:
            prop.kind = PropKind.Number;
            break;

          case ts.SyntaxKind.StringLiteral:
          case ts.SyntaxKind.StringKeyword:
            prop.kind = PropKind.String;
            break;
          case ts.SyntaxKind.BooleanKeyword:
            prop.kind = PropKind.Boolean;
            break;
          case ts.SyntaxKind.VoidKeyword:
            prop.kind = PropKind.Void;
            break;
          case ts.SyntaxKind.ObjectKeyword:
            prop.kind = PropKind.Object;
            break;
          case ts.SyntaxKind.AnyKeyword:
            prop.kind = PropKind.Any;
            break;
          case ts.SyntaxKind.UnknownKeyword:
            prop.kind = PropKind.Unknown;
            break;
          case ts.SyntaxKind.NullKeyword:
            prop.kind = PropKind.Null;
            break;
          case ts.SyntaxKind.UndefinedKeyword:
            prop.kind = PropKind.Undefined;
            break;
          case ts.SyntaxKind.JSDocPropertyTag:
          case ts.SyntaxKind.JSDocParameterTag:
            parseJSDocTag(this, prop, node as ts.JSDocTag);
            break;
        }
      }
    }
    return prop;
  }

  private getTypeIndexes(type: ts.Type): PropType[] {
    interface InterfaceOrTypeWithINdex extends ts.InterfaceType {
      stringIndexInfo?: ts.IndexInfo;
      numberIndexInfo?: ts.IndexInfo;
    }
    const result = [];
    if (type) {
      if (type.flags & ts.TypeFlags.Object || type.isClassOrInterface()) {
        const numberIndex = (type as InterfaceOrTypeWithINdex).numberIndexInfo;
        if (numberIndex?.declaration) {
          const index = this.parseTypeValueComments(
            {},
            numberIndex.declaration,
          );
          if (index) {
            result.push(index);
          }
        }
        const stringIndex = (type as InterfaceOrTypeWithINdex).stringIndexInfo;
        if (stringIndex?.declaration) {
          const index = this.parseTypeValueComments(
            {},
            stringIndex.declaration,
          );
          if (index) {
            result.push(index);
          }
        }
      }
    }
    return result;
  }
  private parseSymbolProp(prop: PropType, symbol: ts.Symbol): PropType | null {
    const symbolDeclaration =
      symbol.valueDeclaration || symbol.declarations?.[0];
    const symbolType = getSymbolType(this.checker, symbol);
    const declaration = symbolDeclaration;

    updateModifiers(prop, declaration);

    if (declaration) {
      prop.displayName = getDeclarationName(declaration);
    }
    if (symbolType) {
      const resolved = resolveType(
        {
          symbolType,
          declaration,
          checker: this.checker,
        },
        this.options,
      );
      const initializer = resolved.initializer;
      const resolvedType = resolved.type;
      if (resolved.framework) {
        prop.framework = resolved.framework;
      }
      updatePropKind(prop, resolvedType);
      if (resolved.name) {
        prop.displayName = resolved.name;
      }
      if (
        resolvedType &&
        resolvedType.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)
      ) {
        const resolvedSymbol = resolvedType.aliasSymbol || resolvedType.symbol;
        const resolvedDeclaration = resolvedSymbol
          ? resolvedSymbol.valueDeclaration || resolvedSymbol.declarations?.[0]
          : undefined;
        if (
          !resolvedDeclaration ||
          !(
            isHasType(resolvedDeclaration) &&
            resolvedDeclaration.type &&
            isArrayLike(resolvedDeclaration.type)
          )
        ) {
          const kind =
            resolved.kind !== undefined
              ? resolved.kind
              : tsKindToPropKind[
                  resolvedDeclaration?.kind ||
                    ts.SyntaxKind.TypeAliasDeclaration
                ] || PropKind.Type;
          prop.kind = kind;
          const childProps = resolvedType.getApparentProperties();
          const properties: PropType[] = [];
          for (const childSymbol of childProps) {
            const d =
              childSymbol.valueDeclaration || childSymbol.declarations?.[0];
            if (!d) {
              //tuple members do not carry type information
              return this.parseTypeValueComments(
                prop,
                declaration,
                initializer,
              );
            }
            const parent = this.getParent(prop, d, prop.displayName);
            if (parent !== undefined) {
              const childProp = this.parseSymbolProp(
                { parent: prop.displayName },
                childSymbol,
              );
              if (childProp) {
                if (parent && parent.displayName) {
                  const parentName = parent.displayName;
                  childProp.parent = parentName;
                } else {
                  delete childProp.parent;
                }
                properties.push(childProp);
              }
            }
          }
          const indexes = this.getTypeIndexes(resolvedType);
          properties.unshift(...indexes);
          if (!resolved.skipParameters) {
            const callSignatures = resolvedType.getCallSignatures();
            if (callSignatures?.length) {
              const fnDeclaration = callSignatures[0].declaration;
              if (fnDeclaration && isFunctionLike(fnDeclaration)) {
                this.parseFunction(prop, fnDeclaration);
              }
            }
          }

          if (properties.length) {
            (prop as TypeProp).properties = properties;
          }

          if (
            !resolved.skipGenerics &&
            resolvedDeclaration &&
            isTypeParameterType(resolvedDeclaration) &&
            resolvedDeclaration.typeParameters?.length
          ) {
            (prop as TypeProp).generics = this.parseProperties(
              resolvedDeclaration.typeParameters,
            );
          }
          //any initializer values
          this.parseValue(prop, initializer);
          if (!prop.displayName) {
            prop.displayName = symbol.getName();
          }

          return this.mergeNodeComments(prop, declaration);
        }
      }
    }

    return this.parseTypeValueComments(
      prop,
      declaration,
      getInitializer(declaration),
    );
  }
  private skipProperty(name?: string): boolean {
    return name !== undefined && this.options.internalTypes.includes(name);
  }
  private mergeNodeComments(prop: PropType, node?: ts.Node): PropType | null {
    if (node) {
      //jsdoc comments at the symbol level are mangled for overloaded methods
      // example getters/setters and index properties
      // so first try if jsdoc comments are already chached.
      const { jsDoc } = node as unknown as {
        jsDoc: JSDocInfoType[];
      };
      if (jsDoc) {
        const description = jsDoc
          .map(({ comment }) => tagCommentToString(comment))
          .join('');
        if (description) {
          prop.description = description;
        }
      } else {
        const symbol =
          'name' in node
            ? this.checker.getSymbolAtLocation(node['name'])
            : 'symbol' in node
            ? node['symbol']
            : undefined;
        if (symbol) {
          const description = cleanJSDocText(
            symbol
              .getDocumentationComment(this.checker)
              .map(({ text }) => text)
              .join(''),
          );
          if (description) {
            prop.description = description;
          }
        }
      }
      const merged = mergeJSDoc(this, prop, node);
      if (merged === null) {
        return null;
      }
      Object.assign(prop, merged);
    }
    return prop;
  }
  private parseTypeValue(
    prop: PropType,
    declaration?: ts.Node,
    initializer?: ts.Node,
  ): PropType {
    this.parseType(prop, declaration);
    if (declaration && ts.isLiteralTypeNode(declaration)) {
      this.parseValue(prop, declaration.literal);
    }
    this.parseValue(prop, initializer);
    return prop;
  }
  private parseTypeValueComments(
    prop: PropType,
    declaration?: ts.Node,
    initializer?: ts.Node,
  ): PropType | null {
    this.parseTypeValue(prop, declaration, initializer);
    return this.mergeNodeComments(prop, declaration);
  }

  private resolveRefTypes = () => {
    let i = 0;
    while (i < 5) {
      const chachedSymbols = this.refSymbols.filter((r) => r.props.length);
      if (!chachedSymbols.length) {
        break;
      }
      chachedSymbols.forEach((ref) => {
        const { props, symbol } = ref;
        ref.props = [];
        const p = this.parseSymbolProp({}, symbol);
        if (p) {
          const { displayName, ...rest } = p;
          const type: PropType | string | undefined = Object.keys(rest).length
            ? p
            : displayName;
          props.forEach((prop) => {
            if (typeof type === 'string') {
              if (prop.displayName && prop.displayName !== type) {
                prop.type = type;
              } else {
                prop.displayName = type;
              }
            } else {
              Object.assign(prop, rest);
              if (prop.displayName) {
                if (!prop.type && prop.displayName !== displayName) {
                  prop.type = displayName;
                }
              } else {
                prop.displayName = displayName;
              }
            }
          });
        }
      });
      i += 1;
    }
  };

  get parents(): Record<string, PropType> {
    return this.propParents;
  }

  public resetParents(): void {
    this.propParents = {};
  }
  public parseSymbol(symbol: ts.Symbol): PropType | null {
    const prop = this.parseSymbolProp({}, symbol);
    this.resolveRefTypes();
    return prop;
  }
}

import type {
  IsEqual,
  ConditionalSimplifyDeep,
  UnknownRecord,
  IsEmptyObject,
  IsNever,
} from "type-fest";
import type { ApplyDefaultOptions, IsPlainObject } from "type-fest/source/internal";
declare module "type-fest" {
  type AssertCondition<
    Type,
    Condition,
    Options extends ConditionalOmitDeepOptions,
  > = Options["condition"] extends "equality"
    ? IsEqual<Type, Condition> extends true
      ? false
      : true
    : Type extends Condition
      ? false
      : true;

  export type ConditionalOmitDeepOptions = {
    condition?: "extends" | "equality";
  };

  type DefaultConditionalOmitDeepOptions = {
    condition: "extends";
  };

  export type ConditionalOmitDeep<
    Type,
    Condition,
    // oxlint-disable-next-line no-empty-object-type
    Options extends ConditionalOmitDeepOptions = {},
  > = _ConditionalOmitDeep<
    Type,
    Condition,
    ApplyDefaultOptions<ConditionalOmitDeepOptions, DefaultConditionalOmitDeepOptions, Options>
  >;

  type _NeverIfEmpty<Type> = Type extends unknown
    ? IsEmptyObject<Type> extends true
      ? never
      : Type
    : never;

  type _ConditionalOmitDeep<
    Type,
    Condition,
    Options extends Required<ConditionalOmitDeepOptions>,
  > = Type extends unknown
    ? _NeverIfEmpty<
        ConditionalSimplifyDeep<
          {
            [
              Key in keyof Type as AssertCondition<Type[Key], Condition, Options> extends true
                ? Key
                : IsPlainObject<Type[Key]> extends true
                  ? IsNever<_ConditionalOmitDeep<Type[Key], Condition, Options>> extends true
                    ? never
                    : Key
                  : never
            ]: AssertCondition<Type[Key], Condition, Options> extends true
              ? Type[Key]
              : _ConditionalOmitDeep<Type[Key], Condition, Options>;
          },
          never,
          UnknownRecord
        >
      >
    : never;
}

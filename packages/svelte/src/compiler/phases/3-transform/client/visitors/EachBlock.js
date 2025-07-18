/** @import { BlockStatement, Expression, Identifier, Pattern, Statement } from 'estree' */
/** @import { AST, Binding } from '#compiler' */
/** @import { ComponentContext } from '../types' */
/** @import { Scope } from '../../../scope' */
import {
	EACH_INDEX_REACTIVE,
	EACH_IS_ANIMATED,
	EACH_IS_CONTROLLED,
	EACH_ITEM_IMMUTABLE,
	EACH_ITEM_REACTIVE
} from '../../../../../constants.js';
import { dev } from '../../../../state.js';
import { extract_paths, object } from '../../../../utils/ast.js';
import * as b from '#compiler/builders';
import { get_value } from './shared/declarations.js';
import { build_expression, add_svelte_meta } from './shared/utils.js';

/**
 * @param {AST.EachBlock} node
 * @param {ComponentContext} context
 */
export function EachBlock(node, context) {
	const each_node_meta = node.metadata;

	// expression should be evaluated in the parent scope, not the scope
	// created by the each block itself
	const parent_scope_state = {
		...context.state,
		scope: /** @type {Scope} */ (context.state.scope.parent)
	};

	const collection = build_expression(
		{
			...context,
			state: parent_scope_state
		},
		node.expression,
		node.metadata.expression
	);

	if (!each_node_meta.is_controlled) {
		context.state.template.push_comment();
	}

	let flags = 0;

	if (node.metadata.keyed && node.index) {
		flags |= EACH_INDEX_REACTIVE;
	}

	const key_is_item =
		node.key?.type === 'Identifier' &&
		node.context?.type === 'Identifier' &&
		node.context?.name === node.key.name;

	// if the each block expression references a store subscription, we need
	// to use mutable stores internally
	let uses_store;

	for (const binding of node.metadata.expression.dependencies) {
		if (binding.kind === 'store_sub') {
			uses_store = true;
			break;
		}
	}

	for (const binding of node.metadata.expression.dependencies) {
		// if the expression doesn't reference any external state, we don't need to
		// create a source for the item. TODO cover more cases (e.g. `x.filter(y)`
		// should also qualify if `y` doesn't reference state, and non-state
		// bindings should also be fine
		if (binding.scope.function_depth >= context.state.scope.function_depth) {
			continue;
		}

		if (!context.state.analysis.runes || !key_is_item || uses_store) {
			flags |= EACH_ITEM_REACTIVE;
			break;
		}
	}

	if (context.state.analysis.runes && !uses_store) {
		flags |= EACH_ITEM_IMMUTABLE;
	}

	// Since `animate:` can only appear on elements that are the sole child of a keyed each block,
	// we can determine at compile time whether the each block is animated or not (in which
	// case it should measure animated elements before and after reconciliation).
	if (
		node.key &&
		node.body.nodes.some((child) => {
			if (child.type !== 'RegularElement' && child.type !== 'SvelteElement') return false;
			return child.attributes.some((attr) => attr.type === 'AnimateDirective');
		})
	) {
		flags |= EACH_IS_ANIMATED;
	}

	if (each_node_meta.is_controlled) {
		flags |= EACH_IS_CONTROLLED;
	}

	// If the array is a store expression, we need to invalidate it when the array is changed.
	// This doesn't catch all cases, but all the ones that Svelte 4 catches, too.
	let store_to_invalidate = '';
	if (node.expression.type === 'Identifier' || node.expression.type === 'MemberExpression') {
		const id = object(node.expression);
		if (id) {
			const binding = context.state.scope.get(id.name);
			if (binding?.kind === 'store_sub') {
				store_to_invalidate = id.name;
			}
		}
	}

	/** @type {Identifier | null} */
	let collection_id = null;

	// Check if inner scope shadows something from outer scope.
	// This is necessary because we need access to the array expression of the each block
	// in the inner scope if bindings are used, in order to invalidate the array.
	for (const [name] of context.state.scope.declarations) {
		if (context.state.scope.parent?.get(name) != null) {
			collection_id = context.state.scope.root.unique('$$array');
			break;
		}
	}

	const child_state = {
		...context.state,
		transform: { ...context.state.transform },
		store_to_invalidate
	};

	/** The state used when generating the key function, if necessary */
	const key_state = {
		...context.state,
		transform: { ...context.state.transform }
	};

	// We need to generate a unique identifier in case there's a bind:group below
	// which needs a reference to the index
	const index =
		each_node_meta.contains_group_binding || !node.index ? each_node_meta.index : b.id(node.index);
	const item = node.context?.type === 'Identifier' ? node.context : b.id('$$item');

	let uses_index = each_node_meta.contains_group_binding;
	let key_uses_index = false;

	if (node.index) {
		child_state.transform[node.index] = {
			read: (node) => {
				uses_index = true;
				return (flags & EACH_INDEX_REACTIVE) !== 0 ? get_value(node) : node;
			}
		};

		key_state.transform[node.index] = {
			read: (node) => {
				key_uses_index = true;
				return node;
			}
		};
	}

	/** @type {Statement[]} */
	const declarations = [];

	const invalidate_store = store_to_invalidate
		? b.call('$.invalidate_store', b.id('$$stores'), b.literal(store_to_invalidate))
		: undefined;

	/** @type {Expression[]} */
	const sequence = [];

	if (!context.state.analysis.runes) {
		/** @type {Set<Identifier>} */
		const transitive_deps = new Set();

		if (collection_id) {
			transitive_deps.add(collection_id);
			child_state.transform[collection_id.name] = { read: b.call };
		} else {
			for (const binding of each_node_meta.transitive_deps) {
				transitive_deps.add(binding.node);
			}
		}

		for (const block of collect_parent_each_blocks(context)) {
			for (const binding of block.metadata.transitive_deps) {
				transitive_deps.add(binding.node);
			}
		}

		if (transitive_deps.size > 0) {
			const invalidate = b.call(
				'$.invalidate_inner_signals',
				b.thunk(
					b.sequence(
						[...transitive_deps].map(
							(node) => /** @type {Expression} */ (context.visit({ ...node }, child_state))
						)
					)
				)
			);

			sequence.push(invalidate);
		}
	}

	if (invalidate_store) {
		sequence.push(invalidate_store);
	}

	if (node.context?.type === 'Identifier') {
		const binding = /** @type {Binding} */ (context.state.scope.get(node.context.name));

		child_state.transform[node.context.name] = {
			read: (node) => {
				if (binding.reassigned) {
					// we need to do `array[$$index]` instead of `$$item` or whatever
					// TODO 6.0 this only applies in legacy mode, reassignments are
					// forbidden in runes mode
					return b.member(
						collection_id ? b.call(collection_id) : collection,
						(flags & EACH_INDEX_REACTIVE) !== 0 ? get_value(index) : index,
						true
					);
				}

				return (flags & EACH_ITEM_REACTIVE) !== 0 ? get_value(node) : node;
			},
			assign: (_, value) => {
				uses_index = true;

				const left = b.member(
					collection_id ? b.call(collection_id) : collection,
					(flags & EACH_INDEX_REACTIVE) !== 0 ? get_value(index) : index,
					true
				);

				return b.sequence([b.assignment('=', left, value), ...sequence]);
			},
			mutate: (_, mutation) => {
				uses_index = true;
				return b.sequence([mutation, ...sequence]);
			}
		};

		delete key_state.transform[node.context.name];
	} else if (node.context) {
		const unwrapped = (flags & EACH_ITEM_REACTIVE) !== 0 ? b.call('$.get', item) : item;

		const { inserts, paths } = extract_paths(node.context, unwrapped);

		for (const { id, value } of inserts) {
			id.name = context.state.scope.generate('$$array');
			child_state.transform[id.name] = { read: get_value };

			const expression = /** @type {Expression} */ (context.visit(b.thunk(value), child_state));
			declarations.push(b.var(id, b.call('$.derived', expression)));
		}

		for (const path of paths) {
			const name = /** @type {Identifier} */ (path.node).name;
			const needs_derived = path.has_default_value; // to ensure that default value is only called once

			const fn = b.thunk(/** @type {Expression} */ (context.visit(path.expression, child_state)));

			declarations.push(b.let(path.node, needs_derived ? b.call('$.derived_safe_equal', fn) : fn));

			const read = needs_derived ? get_value : b.call;

			child_state.transform[name] = {
				read,
				assign: (_, value) => {
					const left = /** @type {Pattern} */ (path.update_expression);
					return b.sequence([b.assignment('=', left, value), ...sequence]);
				},
				mutate: (_, mutation) => {
					return b.sequence([mutation, ...sequence]);
				}
			};

			// we need to eagerly evaluate the expression in order to hit any
			// 'Cannot access x before initialization' errors
			if (dev) {
				declarations.push(b.stmt(read(b.id(name))));
			}

			delete key_state.transform[name];
		}
	}

	const block = /** @type {BlockStatement} */ (context.visit(node.body, child_state));

	/** @type {Expression} */
	let key_function = b.id('$.index');

	if (node.metadata.keyed) {
		const pattern = /** @type {Pattern} */ (node.context); // can only be keyed when a context is provided
		const expression = /** @type {Expression} */ (
			context.visit(/** @type {Expression} */ (node.key), key_state)
		);

		key_function = b.arrow(key_uses_index ? [pattern, index] : [pattern], expression);
	}

	if (node.index && each_node_meta.contains_group_binding) {
		// We needed to create a unique identifier for the index above, but we want to use the
		// original index name in the template, therefore create another binding
		declarations.push(b.let(node.index, index));
	}

	const { has_await } = node.metadata.expression;
	const get_collection = b.thunk(collection, has_await);
	const thunk = has_await ? b.thunk(b.call('$.get', b.id('$$collection'))) : get_collection;

	const render_args = [b.id('$$anchor'), item];
	if (uses_index || collection_id) render_args.push(index);
	if (collection_id) render_args.push(collection_id);

	/** @type {Expression[]} */
	const args = [
		context.state.node,
		b.literal(flags),
		thunk,
		key_function,
		b.arrow(render_args, b.block(declarations.concat(block.body)))
	];

	if (node.fallback) {
		args.push(
			b.arrow([b.id('$$anchor')], /** @type {BlockStatement} */ (context.visit(node.fallback)))
		);
	}

	const statements = [add_svelte_meta(b.call('$.each', ...args), node, 'each')];

	if (dev && node.metadata.keyed) {
		statements.unshift(b.stmt(b.call('$.validate_each_keys', thunk, key_function)));
	}

	if (has_await) {
		context.state.init.push(
			b.stmt(
				b.call(
					'$.async',
					context.state.node,
					b.array([get_collection]),
					b.arrow([context.state.node, b.id('$$collection')], b.block(statements))
				)
			)
		);
	} else {
		context.state.init.push(...statements);
	}
}

/**
 * @param {ComponentContext} context
 */
function collect_parent_each_blocks(context) {
	return /** @type {AST.EachBlock[]} */ (context.path.filter((node) => node.type === 'EachBlock'));
}

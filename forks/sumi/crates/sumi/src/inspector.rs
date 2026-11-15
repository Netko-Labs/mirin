/// What an element was told it is to the inspector.
// mirin: sumi has no inspector. The type stays, empty, so `Element`'s
// methods keep the shape they have upstream and an element picked from
// there needs no change; every element is handed `None`.
#[derive(Debug, Eq, PartialEq, Hash, Clone)]
pub struct InspectorElementId {}
